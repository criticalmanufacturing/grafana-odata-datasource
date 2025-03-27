import { QueryEditorProps } from '@grafana/data';
import { InlineFormLabel, Input } from '@grafana/ui';
import React, { PureComponent } from 'react';
import { ODataSource } from '../DataSource';
import { ODataOptions, ODataQuery } from '../types';

type Props = QueryEditorProps<ODataSource, ODataQuery, ODataOptions>;

interface State {
  oDataQueryString: string;
}

export class VariableQueryEditor extends PureComponent<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      oDataQueryString: props.query.oDataQueryString || '',
    };
  }

  onODataQueryStringChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const oDataQueryString = event.target.value;
    this.setState({ oDataQueryString });
    this.props.onChange({ ...this.props.query, oDataQueryString });
  };

  render() {
    const { oDataQueryString } = this.state;

    return (
      <div>
        <div className="gf-form-inline">
          <div className="gf-form" style={{ width: '100%' }}>
            <InlineFormLabel width={8} tooltip="Write the full OData Query.">OData Query</InlineFormLabel>
            <Input
              value={oDataQueryString}
              required
              type="text"
              placeholder="(odata query)"
              onChange={this.onODataQueryStringChange}
              style={{ width: '100%' }}
            />
          </div>
        </div>
      </div>
    );
  }
}
