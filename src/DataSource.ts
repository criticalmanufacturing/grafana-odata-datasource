import { DataQueryRequest, DataSourceInstanceSettings, MetricFindValue, ScopedVars } from '@grafana/data';
import { DataSourceWithBackend, getTemplateSrv } from '@grafana/runtime';
import { ODataOptions, ODataQuery } from './types';
import { firstValueFrom } from 'rxjs';

export class ODataSource extends DataSourceWithBackend<ODataQuery, ODataOptions> {
  constructor(instanceSettings: DataSourceInstanceSettings<ODataOptions>) {
    super(instanceSettings);
  }

  /**
   * 
   * @param query The ODATA query
   * @param scopedVars Dashboard/panel variables like including time ranges or intervals
   * @returns the query with variables replaced by their values
   */
  applyTemplateVariables(query: ODataQuery, scopedVars: ScopedVars) {
    const templateSrv = getTemplateSrv();
    const singleQuoteFlags: boolean[] = []; // track which variable occurrences had :singlequote, in order
    const applySingleQuote = (value: string) => `'${value}'`; // No need to do .replace(/'/g, "''") because encodeODataValue is always called first
    const encodeODataValue = (value: string) => encodeURIComponent(value).replace(/'/g, "''"); // apply percent encoding and escape single quotes by duplicating them

    // try to match ${varName:format}
    const stripped = query.oDataQueryString?.replace(/\$\{([^:}]+)(?::([^}]+))?\}/g, (match, varName, format) => {
      if (format === 'singlequote') {
        singleQuoteFlags.push(true);
        return `\${${varName}}`; // strip the :singlequote
      }
      singleQuoteFlags.push(false);
      return match; // leave other formats intact
    });

    query.filterConditions?.forEach((filterCondition) => {
      filterCondition.value = templateSrv.replace(filterCondition.value, scopedVars);
    });

    let callIndex = 0;
    const oDataQueryString = templateSrv.replace(stripped, scopedVars, (value: string | string[]) => {
      const hadSingleQuote = singleQuoteFlags[callIndex++]; // used to check if the string must be surrounded by single quotes

      if (Array.isArray(value)) {
        return value
          .map(v => {
            const encoded = encodeODataValue(v);
            return hadSingleQuote ? applySingleQuote(encoded) : encoded;
          })
          .join(',');
      }

      const encoded = encodeODataValue(value);
      return hadSingleQuote ? applySingleQuote(encoded) : encoded;
    });

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
