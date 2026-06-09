import { DataQueryRequest, DataSourceInstanceSettings, MetricFindValue, ScopedVars } from '@grafana/data';
import { DataSourceWithBackend, getTemplateSrv, VariableInterpolation } from '@grafana/runtime';
import { ODataOptions, ODataQuery } from './types';
import { firstValueFrom } from 'rxjs';

export class ODataSource extends DataSourceWithBackend<ODataQuery, ODataOptions> {
  constructor(instanceSettings: DataSourceInstanceSettings<ODataOptions>) {
    super(instanceSettings);
  }

  /**
   * Split the interior of a ['a','b','can't'] literal into raw inner strings. No spaces are expected between elements
   * Every element starts with ' (we strip it) or the element is empty like in [,,'ab']
   * Because unescaped inner quotes exist, we search for the separator ', or keep iterating over commas until a single quote is found
   * @param interior 
   * @returns 
   */
   private splitQuotedArray(interior: string) {
    const results = [];
    let remaining = interior; 
    
    while (remaining.length > 0) {
      if (remaining.startsWith("'")) {
        // Non-empty element
        remaining = remaining.slice(1); // strip the opening quote
   
        // Find the next ', which marks the end of this
        const separatorIndex = remaining.indexOf("',");
   
        if (separatorIndex === -1) {
          // Last quoted element: content runs to the final ' in the string,
          // followed by optional trailing empty slots (commas).
          const lastQuote = remaining.lastIndexOf("'");
          if (lastQuote === -1) {
            results.push(remaining); // malformed - take the whole remainder
            break;
          }
          results.push(remaining.slice(0, lastQuote));
          // Any trailing commas after the closing quote become empty slots.
          remaining = remaining.slice(lastQuote + 1);
          // fall through to the comma-handling loop below
        } 
        else {
          results.push(remaining.slice(0, separatorIndex)); // content before closing quote
          remaining = remaining.slice(separatorIndex + 1);  // move past the comma; next char is '
          continue;
        }
      }
   
      // Empty slots (leading, trailing, or consecutive commas)
      // remaining starts with ',' or is just leftover commas after the last quote.
      while (remaining.startsWith(',')) {
        if (remaining === interior) {results.push(null)}; // in the case that the array starts with a comma
        const next = remaining.slice(1);
        if (next.length === 0 || next.startsWith(',')) {
          results.push(null); // comma followed by another comma or end → empty slot
        }
        // else: comma followed by ' → next quoted element, let the outer loop handle it
        remaining = next;
      }
   
      // If something other than ' or , is left the format is unexpected — stop.
      if (remaining.length > 0 && !remaining.startsWith("'")) {
        break;
      }
    }
   
    return results;
  }


  /**
   * Attempt to parse a string that represent an array like ['a','b'].
   * Quoted elements get encoded and their inner singlequotes are dupliacted. Unquoted elements are just encoded
   * @param value 
   * @param usePost 
   * @returns 
   */
  private parseArrayLiteral(value: string, usePost: boolean): string | null {
    const arrayMatch = value.match(/^\s*\[([\s\S]*)\]\s*$/);
    if (!arrayMatch) {return null;}

    const interior = arrayMatch[1].trim();
    if (!interior) {return value;}

    // Determine if this is a quoted-string array by checking if the first
    // non-whitespace character after '[' is a single quote.
    const isStringArray = interior.trimStart().indexOf("[,") !== -1 || interior.trimStart().indexOf(",'") !== -1;  // [, ou ['

    if (!isStringArray) {
      // Unquoted array (numbers, bools, etc.) — simple comma split is safe.
      const elements = interior.split(',');
      const processed = elements.map(item =>
        this.encodeODataValue(item.trim(), usePost, false)
      );
      return `[${processed.join(',')}]`;
    }

    // handle cases like
    //   ['a','b'] -- ['a', 'b']
    //   ['can't','d'] -- ['can''t', 'd']
    //   ['a,b','c'] -- ['a,b', 'c']
    //   [,,'a&b','bc',,] -- [,,'a%26b','bc',,]
    const rawElements = this.splitQuotedArray(interior);
    const processed = rawElements.map(raw => { // raw is the inner content (outer quotes already stripped)
      if (raw === null) {
        return ''; // empty -> preserve the comma, emit nothing between them
      }
      return this.wrapSingleQuotes(this.encodeODataValue(raw, usePost, true));
    });

    return `[${processed.join(',')}]`;
  };

  /**
   * Percent encode a string. Encode twice if it is a POST request
   * @param value string to encode
   * @param usePost whether the request is a POST request
   * @param escapeSingleQuotes whether to double single quotes
   * @returns 
   */
  private encodeODataValue(value: string, usePost: boolean, escapeSingleQuotes: boolean){
    const escaped = escapeSingleQuotes ? value.replace(/'/g, "''") : value;
    const encoded = encodeURIComponent(escaped);
    // ! Grafana decodes the query string once before forwarding when using POST so we encode it twice
    return usePost ? encodeURIComponent(encoded) : encoded;
  };

  private wrapSingleQuotes(value: string) {return `'${value}'`;}

  /**
   * Replace variables in an ODATA query by their values, correctly escaped
   * @param query The ODATA query
   * @param scopedVars Dashboard/panel variables like including time ranges or intervals. Not the 'normal' user defined variables
   * @returns the query with variables replaced by their values
   */
  applyTemplateVariables(query: ODataQuery, scopedVars: ScopedVars) {
    const templateSrv = getTemplateSrv();
    const knownVars = new Set(templateSrv.getVariables().map(v => v.name));
    const isKnownVar = (name: string) => knownVars.has(name); // used to not detect $select, $filter, etc. has variables
    const usePost = query.usePost ?? false;

    query.filterConditions?.forEach((filterCondition) => {
      filterCondition.value = templateSrv.replace(filterCondition.value, scopedVars);
    });

    // Pre-pass: find variables already wrapped in '...'
    const quotedVarNames = new Set<string>();

    query.oDataQueryString?.replace(
      /'((?:[^']|'')*)'/g,
      (_match, content: string) => {
        const varPattern = /\$\{([^:}]+)(?::[^}]*)?\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g; // match '$var' or '${var}'
        let m: RegExpExecArray | null;
        while ((m = varPattern.exec(content)) !== null) {
          const varName = m[1] ?? m[2];
          if (isKnownVar(varName)) {
            quotedVarNames.add(varName);
          }
        }
        return _match; // no substitution
      }
    );

    // Remove surrounding quotes from '$var' / '${var}' occurrences, so they are reintroduced later together with :singlequote
    const withoutSurroundingQuotes = query.oDataQueryString?.replace(
      /'(\$(?:\{[^}]+\}|[a-zA-Z_][a-zA-Z0-9_]*))'/g,
      (_match, varExpr: string) => {
        const nameMatch =
          varExpr.match(/^\$\{([^:}]+)(?::[^}]*)?\}$/) ??
          varExpr.match(/^\$([a-zA-Z_][a-zA-Z0-9_]*)$/);
        const varName = nameMatch?.[1];
        if (!varName || !isKnownVar(varName)) { return _match; }
        return varExpr;
      }
    );

    // Strip pass: remove :singlequote format, collect flags keyed by variable name
    interface VarFlags {
      wrapQuotes: boolean;
      escapeQuotes: boolean;
      scalarOnly: boolean; // the value cannot be an actual array, but can be a string representing an array
    }
    const varFlagsMap = new Map<string, VarFlags>();

    const stripped = withoutSurroundingQuotes?.replace(
      /\$\{([^:}]+)(?::([^}]+))?\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g, // matches ${var1:format} or $var2
      (match, var1: string, format: string | undefined, var2: string) => {
        const varName = var1 ?? var2;
        if (!isKnownVar(varName)) { return match; }

        const hasSingleQuoteFormat = format === 'singlequote';
        const wasQuoted = quotedVarNames.has(varName);

        varFlagsMap.set(varName, {
          wrapQuotes: hasSingleQuoteFormat || wasQuoted,
          escapeQuotes: hasSingleQuoteFormat || wasQuoted,
          scalarOnly: wasQuoted && !hasSingleQuoteFormat,
        });

        if (hasSingleQuoteFormat) {
          return `\${${varName}}`; // strip :singlequote
        }
        return match;
      }
    );

    // Replacement pass
    const oDataQueryString = templateSrv.replace(
      stripped,
      scopedVars,
      (value: string | string[], varInterpolation: any) => { // :singlequote was removed but any other format like :percentencode override this one
        const flags = varFlagsMap.get(varInterpolation.id) ?? { // The tooltip suggests this is of the type VariableInterpolation[] but it does not seem so
          wrapQuotes: false,
          escapeQuotes: false,
          scalarOnly: false,
        };

        // 1. '$var' / '${var}': always scalar, duplicate single quotes, encode and wrap in single quotes
        if (flags.scalarOnly) {
          const scalar = Array.isArray(value) ? (value as string[]).join(',') : value as string; // Assuming that if the variable is wrapped in quotes it will not be treated as an array
          return this.wrapSingleQuotes(this.encodeODataValue(scalar, usePost, true));
        }

        // 2. :singlequote if actual array: duplicate single quotes, encode and wrap in single quotes per element
        // Still enncode every element if it is an array but did not have :singlequote
        if (Array.isArray(value)) {
          return (value as string[])
            .map(v => {
              const encoded = this.encodeODataValue(v, usePost, flags.escapeQuotes);
              return flags.wrapQuotes ? this.wrapSingleQuotes(encoded) : encoded;
            })
            .join(',');
        }

        // 3. Scalar string
        const scalar = value as string;

        // :singlequote scalar: duplicate single quotes, encode and wrap in single quotes, no [..] parsing
        if (flags.wrapQuotes) {
          return this.wrapSingleQuotes(this.encodeODataValue(scalar, usePost, true));
        }

        // Plain scalar: attempt [...] parsing, else just encode the whole value
        const parsed = this.parseArrayLiteral(scalar, usePost);
        return parsed ?? this.encodeODataValue(scalar, usePost, false);
      }
    );

    return { ...query, oDataQueryString };
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
