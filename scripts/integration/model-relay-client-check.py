"""Construct both actual LangChain request protocols without a provider call."""
import sys
from pathlib import Path
from types import SimpleNamespace

root = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(root / 'integrations/agenthub'), str(root / 'vendor/agenthub/backend')]
from model_relay import build_client, validate_endpoint
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage

endpoint = 'http://127.0.0.1:5487/internal/model/v1'
for invalid in ['https://127.0.0.1:5487/internal/model/v1',
                'http://localhost:5487/internal/model/v1', endpoint + '?x=1',
                'http://169.254.169.254:5487/internal/model/v1']:
    try:
        validate_endpoint(invalid)
        raise AssertionError('unsafe relay endpoint accepted')
    except RuntimeError:
        pass
data = {'model_mode': 'relay', 'model_relay_endpoint': endpoint}
for mode in ['chat-completions', 'responses']:
    binding = {'model': 'virtual-choice', 'endpoint': endpoint, 'effort': 'high',
               'maxOutputTokens': 256, 'contextWindow': 32000, 'apiMode': mode}
    model = SimpleNamespace(provider='synplex-run:fixture', model='virtual-choice',
                            base_url=endpoint, api_key='synthetic-relay-token',
                            config={'synplex_relay': binding, 'reasoning_effort': 'high'},
                            max_tokens=256, max_retries=0, timeout=90)
    client = build_client(data, model, reasoning_effort='high')
    messages = [HumanMessage(content='write a document'),
                AIMessage(content='', additional_kwargs={'reasoning_content': 'private reasoning'},
                          tool_calls=[{'id': 'call-fixture', 'name': 'document', 'args': {'title': 'plan'}}]),
                ToolMessage(content='file saved', tool_call_id='call-fixture')]
    request = client._get_request_payload(messages)
    assert request['model'] == 'virtual-choice'
    assert client.max_retries == 0
    if mode == 'responses':
        assert isinstance(request['input'], list)
        assert request['reasoning']['effort'] == 'high'
        assert request['max_output_tokens'] == 256
        assert 'messages' not in request
    else:
        assert request['messages'][1]['reasoning_content'] == 'private reasoning'
        assert request['reasoning_effort'] == 'high'
    model.max_retries = 2
    try:
        build_client(data, model)
        raise AssertionError('automatic retry accepted')
    except RuntimeError:
        pass
print('Both protocol payloads, private tool reasoning and no-retry binding verified; provider calls: 0')
