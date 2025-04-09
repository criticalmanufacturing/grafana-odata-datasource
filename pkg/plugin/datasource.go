package plugin

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/d-velop/grafana-odata-datasource/pkg/plugin/odata"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/datasource"
	"github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/data"
)

var (
	_ backend.QueryDataHandler    = (*ODataSource)(nil)
	_ backend.CheckHealthHandler  = (*ODataSource)(nil)
	_ backend.CallResourceHandler = (*ODataSource)(nil)
)

type ODataSource struct {
	im instancemgmt.InstanceManager
}

type DatasourceSettings struct {
	URLSpaceEncoding string `json:"urlSpaceEncoding"`
}

func newDatasourceInstance(ctx context.Context, settings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	clientOptions, err := settings.HTTPClientOptions(ctx)
	if err != nil {
		return nil, err
	}
	client, err := httpclient.New(clientOptions)
	if err != nil {
		return nil, err
	}

	var dsSettings DatasourceSettings
	if settings.JSONData != nil && len(settings.JSONData) > 1 {
		if err := json.Unmarshal(settings.JSONData, &dsSettings); err != nil {
			return nil, err
		}
	}

	return &ODataSourceInstance{
		client: &ODataClientImpl{
			httpClient:       client,
			baseUrl:          settings.URL,
			urlSpaceEncoding: dsSettings.URLSpaceEncoding,
			cookieHeader:     "",
		},
	}, nil
}

type ODataSourceInstance struct {
	client ODataClient
}

func NewODataSource(ctx context.Context, _ backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	im := datasource.NewInstanceManager(newDatasourceInstance)
	ds := &ODataSource{
		im: im,
	}
	return ds, nil
}

func (ds *ODataSource) getClientInstance(ctx context.Context, pluginContext backend.PluginContext) ODataClient {
	instance, _ := ds.im.Get(ctx, pluginContext)
	clientInstance := instance.(*ODataSourceInstance).client
	return clientInstance
}

func (ds *ODataSource) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	rawInstance, _ := ds.im.Get(ctx, req.PluginContext)
	dsInstance := rawInstance.(*ODataSourceInstance)

	clientImpl, ok := dsInstance.client.(*ODataClientImpl)
	if !ok {
		return nil, fmt.Errorf("expected *ODataClientImpl, got something else")
	}

	cookieHeaders, ok := req.Headers["Cookie"]
	if !ok || len(cookieHeaders) == 0 {
		clientImpl.SetCookieHeader("")
	} else {
		clientImpl.SetCookieHeader(cookieHeaders)
	}
	
	clientInstance := ds.getClientInstance(ctx, req.PluginContext)
	response := backend.NewQueryDataResponse()
	for _, q := range req.Queries {
		res := ds.query(clientInstance, q)
		response.Responses[q.RefID] = res
	}
	return response, nil
}

func (ds *ODataSource) CheckHealth(ctx context.Context, req *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	var status backend.HealthStatus
	var message string
	clientInstance := ds.getClientInstance(ctx, req.PluginContext)
	var res, err = clientInstance.GetServiceRoot()
	if err != nil {
		status = backend.HealthStatusError
		message = fmt.Sprintf("Health check failed: %s", err.Error())
	} else {
		if res.StatusCode == 200 {
			status = backend.HealthStatusOk
			message = "Data Source is working as expected."
		} else {
			status = backend.HealthStatusError
			message = fmt.Sprintf("Health check failed, datasource exists but given path does not. "+
				"Statuscode: %d", res.StatusCode)
		}
	}
	return &backend.CheckHealthResult{
		Status:  status,
		Message: message,
	}, nil
}

func (ds *ODataSource) CallResource(ctx context.Context, req *backend.CallResourceRequest,
	sender backend.CallResourceResponseSender) error {
	rawInstance, _ := ds.im.Get(ctx, req.PluginContext)
	dsInstance := rawInstance.(*ODataSourceInstance)

	clientImpl, ok := dsInstance.client.(*ODataClientImpl)
	if !ok {
		return fmt.Errorf("expected *ODataClientImpl, got something else")
	}

	cookieHeaders, ok := req.Headers["Cookie"]
	if !ok || len(cookieHeaders) == 0 {
		clientImpl.SetCookieHeader("")
	} else {
		combined := strings.Join(cookieHeaders, "; ")
		clientImpl.SetCookieHeader(combined)
	}

	switch req.Path {
	case "metadata":
		return ds.getMetadata(ctx, req, sender)
	default:
		return sender.Send(&backend.CallResourceResponse{
			Status: http.StatusNotFound,
		})
	}
}

func (ds *ODataSource) query(clientInstance ODataClient, query backend.DataQuery) backend.DataResponse {
	log.DefaultLogger.Debug("query", "query.JSON", string(query.JSON))
	response := backend.DataResponse{}
	var qm queryModel
	err := json.Unmarshal(query.JSON, &qm)
	if err != nil {
		response.Error = fmt.Errorf("error unmarshalling query json: %w", err)
		return response
	}

	// Prevent empty queries from being executed
	if qm.ODataQueryString == "" && qm.TimeProperty == nil && (len(qm.Properties) == 0 || 
	!hasNonEmptyName(qm.Properties)) {
		return response
	}

	frame := data.NewFrame("response")
	frame.Name = query.RefID
	if frame.Meta == nil {
		frame.Meta = &data.FrameMeta{}
	}
	frame.Meta.PreferredVisualization = data.VisTypeTable

	props := qm.Properties
	if qm.TimeProperty != nil {
		props = append(props, *qm.TimeProperty)
	}

	resp, err := clientInstance.Get(qm.ODataQueryString, qm.EntitySet.Name, props,
		append(qm.FilterConditions, TimeRangeToFilter(query.TimeRange, qm.TimeProperty)...), qm.UsePost)
	if err != nil {
		response.Error = err
		return response
	}
	defer resp.Body.Close()

	log.DefaultLogger.Debug("request response status", "status", resp.Status)
	if resp.StatusCode != http.StatusOK {
		response.Error = fmt.Errorf("get failed with status code %d", resp.StatusCode)
		return response
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		response.Error = err
		return response
	}
	var result odata.Response
	err = json.Unmarshal(bodyBytes, &result)
	if err != nil {
		response.Error = err
		return response
	}

	log.DefaultLogger.Debug("query complete", "noOfEntities", len(result.Value))

	index := strings.Index(qm.ODataQueryString, "?")
	
	var tableName string
	
	if index != -1 {
		tableName = qm.ODataQueryString[:index]
	} else {
		tableName = qm.ODataQueryString
	}

	var entityProperties []property

	if qm.ODataQueryString != "" {
		metadataBytes, err := ds.fetchMetadata(clientInstance)
		if err != nil {
			response.Error = err
			return response
		}

		var metadata schema
		err = json.Unmarshal(metadataBytes, &metadata)
		if err != nil {
			response.Error = err
			return response
		}

		entityType, ok := metadata.EntitySets[tableName]
		if !ok {
			response.Error = fmt.Errorf("entity set %s not found in metadata", tableName)
			return response
		}

		entityProperties = metadata.EntityTypes[entityType.EntityType].Properties
	} else {
		entityProperties = props
	}

	if len(result.Value) > 0 {
		firstEntry := result.Value[0]
		for key := range firstEntry {
			var inferredType string
			for _, prop := range entityProperties {
				if prop.Name == key {
					inferredType = prop.Type
					break
				}
			}
			field := data.NewField(key, nil, odata.ToArray(inferredType))
			frame.Fields = append(frame.Fields, field)
		}
	}

	for _, entry := range result.Value {
		values := make([]interface{}, len(frame.Fields))

		for i, field := range frame.Fields {
			if value, ok := entry[field.Name]; ok {
				var inferredType string
				for _, prop := range entityProperties {
					if prop.Name == field.Name {
						inferredType = prop.Type
						break
					}
				}
				values[i] = odata.MapValue(value, inferredType)
			} else {
				values[i] = nil
			}
		}
		frame.AppendRow(values...)
	}

	response.Frames = append(response.Frames, frame)
	return response
}

func (ds *ODataSource) getMetadata(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	clientInstance := ds.getClientInstance(ctx, req.PluginContext)
	responseBody, err := ds.fetchMetadata(clientInstance)
	if err != nil {
		return err
	}

	return sender.Send(&backend.CallResourceResponse{
		Status: http.StatusOK,
		Body:   responseBody,
	})
}

func (ds *ODataSource) fetchMetadata(clientInstance ODataClient) ([]byte, error) {
	resp, err := clientInstance.GetMetadata()
	if err != nil {
		return nil, err
	}

	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("get metadata failed with status code %d", resp.StatusCode)
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		log.DefaultLogger.Error("error reading response body")
		return nil, err
	}

	var edmx odata.Edmx
	err = xml.Unmarshal(bodyBytes, &edmx)
	if err != nil {
		log.DefaultLogger.Error("error unmarshalling response body")
		return nil, err
	}

	metadata := schema{
		EntityTypes: make(map[string]entityType),
		EntitySets:  make(map[string]entitySet),
	}
	for _, ds := range edmx.DataServices {
		for _, s := range ds.Schemas {
			for _, et := range s.EntityTypes {
				qualifiedName := s.Namespace + "." + et.Name
				var properties []property
				for _, p := range et.Properties {
					prop := property{
						Name: p.Name,
						Type: p.Type,
					}
					properties = append(properties, prop)
				}
				metadata.EntityTypes[qualifiedName] = entityType{
					Name:          et.Name,
					QualifiedName: qualifiedName,
					Properties:    properties,
				}
			}
			for _, ec := range s.EntityContainers {
				for _, es := range ec.EntitySet {
					metadata.EntitySets[es.Name] = entitySet{
						Name:       es.Name,
						EntityType: es.EntityType,
					}
				}
			}
		}
	}

	responseBody, err := json.Marshal(metadata)
	if err != nil {
		log.DefaultLogger.Error("error marshalling response body")
		return nil, err
	}

	return responseBody, nil
}

func hasNonEmptyName(properties []property) bool {
    for _, prop := range properties {
        if prop.Name != "" {
            return true
        }
    }
    return false
}
