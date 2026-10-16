// Only documented provider profiles enable tools/effort automatically.
// A catalogue entry alone cannot prove execution compatibility.
export function discoveredModels(catalog,endpoint){
 const host=new URL(endpoint).hostname;
 return catalog.models.map(id=>{const deepseek=host==='api.deepseek.com'&&/^deepseek-(chat|flash|reasoner)$/.test(id);return {id,name:Array.from(id).slice(0,80).join(''),capabilities:{tools:deepseek,stream:true,contextWindow:catalog.capacities?.[id]||32000,efforts:deepseek&&id==='deepseek-flash'?['none','low','high','max']:deepseek&&id==='deepseek-reasoner'?['high']:[]}};});
}
