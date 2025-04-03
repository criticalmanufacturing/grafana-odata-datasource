import { DataQueryRequest, DataSourceInstanceSettings, MetricFindValue, ScopedVars } from '@grafana/data';
import { DataSourceWithBackend, getTemplateSrv } from '@grafana/runtime';
import { ODataOptions, ODataQuery } from './types';
import { firstValueFrom } from 'rxjs';

export class ODataSource extends DataSourceWithBackend<ODataQuery, ODataOptions> {
  constructor(instanceSettings: DataSourceInstanceSettings<ODataOptions>) {
    super(instanceSettings);
  }

  applyTemplateVariables(query: ODataQuery, scopedVars: ScopedVars) {
    const templateSrv = getTemplateSrv();

    query.filterConditions?.forEach((filterCondition) => {
      filterCondition.value = templateSrv.replace(filterCondition.value, scopedVars);
    });

    const oDataQueryString = templateSrv.replace(query.oDataQueryString, scopedVars);

    return {
      ...query,
      oDataQueryString: oDataQueryString
    };
  }

  async metricFindQuery(query: ODataQuery, _options?: any): Promise<MetricFindValue[]> {
    const response = await firstValueFrom(this.query({
      targets: [{...query, refId: 'ODataQuery'}]
    } as DataQueryRequest<ODataQuery>));

    const metricFindValues: MetricFindValue[] = [];
    response.data[0]?.fields.forEach((field: { values: any[]; }) => {
      field.values.forEach((value: any) => {
        metricFindValues.push({
          text: value,
          value: value
        });
      });
    });

  return metricFindValues;
  }
}
