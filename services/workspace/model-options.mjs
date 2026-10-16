// Provider-specific options follow the authenticated connection, never model text.
// DeepSeek Flash enables thinking by default; an explicit "none" must disable it.
export function modelReasoningOptions(binding,body,endpoint){
  const value={...body};
  if(binding.effort===null||binding.effort===undefined)return value;
  if(binding.protocol==='responses'){value.reasoning={...value.reasoning,effort:binding.effort};return value;}
  const official=endpoint&&new URL(endpoint).hostname==='api.deepseek.com'&&binding.model==='deepseek-flash';
  if(official){
    value.thinking={type:binding.effort==='none'?'disabled':'enabled'};
    if(binding.effort==='none'){delete value.reasoning_effort;return value;}
  }
  value.reasoning_effort=binding.effort;return value;
}
