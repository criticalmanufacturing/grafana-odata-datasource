import { QueryEditorProps } from '@grafana/data';
import { InlineFormLabel, Switch, TextArea } from '@grafana/ui';
import React, { PureComponent } from 'react';
import { ODataSource } from '../DataSource';
import { ODataOptions, ODataQuery } from '../types';

type Props = QueryEditorProps<ODataSource, ODataQuery, ODataOptions>;

interface State {
  oDataQueryString: string;
  usePost: boolean;
}

export class VariableQueryEditor extends PureComponent<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      oDataQueryString: props.query.oDataQueryString || '',
      usePost: props.query.usePost || false
    };
  }

  onODataQueryStringChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const oDataQueryString = event.target.value;
    this.setState({ oDataQueryString });
    this.props.onChange({ ...this.props.query, oDataQueryString });
  };

  togglePost = (event: React.ChangeEvent<HTMLInputElement>) => {
    const usePost = event.target.checked;
    this.setState({ usePost });
    this.props.onChange({ ...this.props.query, usePost });
  };

  render() {
    const { oDataQueryString, usePost } = this.state;

    return (
      <div>
        <div className="gf-form-inline">
          <div className="gf-form" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <InlineFormLabel width={10} tooltip="Make the OData request using POST instead of GET.">Use POST Method</InlineFormLabel>
            <Switch value={usePost} onChange={this.togglePost} />
          </div>
        </div>
        <div className="gf-form-inline">
          <div className="gf-form" style={{ width: '100%' }}>
            <InlineFormLabel width={10} tooltip="Write the full OData Query.">OData Query</InlineFormLabel>
          </div>
          <TextArea
            value={oDataQueryString}
            required
            type="text"
            placeholder="(odata query)"
            onChange={this.onODataQueryStringChange}
            style={{ width: '100%' }}
          />
        </div>
      </div>
    );
  }
}
