import {modelFailure} from './model-contract.mjs';
import {probeUsage} from './model-service.mjs';
import {modelReasoningOptions} from './model-options.mjs';

export function buildChatBody(binding,messages,stream,endpoint){
  const body=binding.protocol==='responses'?{model:binding.model,input:messages,max_output_tokens:binding.maxOutputTokens,stream}:{model:binding.model,messages,max_tokens:binding.maxOutputTokens,stream};
  if(stream&&binding.protocol==='chat-completions')body.stream_options={include_usage:true};
  return modelReasoningOptions(binding,body,endpoint);
}
function responseText(value){
  if(value.choices)return value.choices[0]?.message?.content??'';
  return (value.output??[]).filter(item=>item.type==='message').flatMap(item=>item.content??[]).filter(item=>item.type==='output_text').map(item=>item.text).join('');
}
export function createModelDecoder({stream,onText}){
  const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',usage=null,receipt=null,finished=false,output=false,truncated=false;
  function text(value){if(typeof value!=='string')throw modelFailure('模型回复格式不正确。');if(value){output=true;onText(value);}}
  function object(value){
    if(value.error||value.type==='error'||value.type==='response.failed')throw modelFailure('模型未完成这次回复。');
    if(value.id)receipt=String(value.id).slice(0,200);
    if(value.usage)usage=probeUsage(value.usage);
    if(value.choices){const choice=value.choices[0];if(choice?.delta?.content)text(choice.delta.content);if(choice?.finish_reason){if(!['stop','length'].includes(choice.finish_reason))throw modelFailure('这次回复需要切换到执行任务。');finished=true;truncated=choice.finish_reason==='length';}}
    if(value.type==='response.output_text.delta')text(value.delta);
    if(value.type==='response.completed'){finished=true;usage=probeUsage(value.response?.usage);receipt=value.response?.id??receipt;}
    if(value.type==='response.incomplete')throw modelFailure('模型回复中途结束，已返回的内容保留。');
  }
  function event(block){const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)return;if(data==='[DONE]'){finished=true;return;}object(JSON.parse(data));}
  return {
    push(bytes){
      pending+=decoder.decode(bytes,{stream:true});if(pending.length>2*1024*1024)throw modelFailure('模型回复超过本次容量。');
      if(!stream)return;
      pending=pending.replace(/\r\n/g,'\n');let at;while((at=pending.indexOf('\n\n'))>=0){const block=pending.slice(0,at);pending=pending.slice(at+2);event(block);}
    },
    evidence(){return {usage,providerReceipt:receipt};},
    finish(){
      pending+=decoder.decode();
      if(stream){if(pending.trim())event(pending);if(!finished)throw modelFailure('模型回复中断，已有内容保留。');}
      else{const value=JSON.parse(pending);if(value.error)throw modelFailure('模型未接受这次请求。');text(responseText(value));usage=probeUsage(value.usage);receipt=value.id??null;truncated=value.choices?.[0]?.finish_reason==='length'||value.status==='incomplete';}
      if(!output&&!truncated)throw modelFailure('模型没有返回可显示的回复。');return {usage,providerReceipt:receipt,truncated,...(!output?{empty:true}:{})};
    },
  };
}
