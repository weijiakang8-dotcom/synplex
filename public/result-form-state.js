const key=scope=>'synplex-result-forms:'+JSON.stringify(scope);
// Polling may update status during editing; edit state is separate from server data.
export function captureResultForms(document,storage,scope){
 if(!scope||!document.querySelectorAll)return;
 const state=JSON.parse(storage.getItem(key(scope))||'{}');
 for(const form of document.querySelectorAll('.result-review-form,.result-revision-form,.result-followup-form')){
  state[form.className+':'+form.dataset.result]={open:form.closest('details').open,values:Object.fromEntries([...form.elements].filter(x=>x.name&&x.type!=='file').map(x=>[x.name,x.value]))};
 }
 storage.setItem(key(scope),JSON.stringify(state));
}
export function restoreResultForms(document,storage,scope){
 if(!scope||!document.querySelectorAll)return;
 const state=JSON.parse(storage.getItem(key(scope))||'{}');
 for(const form of document.querySelectorAll('.result-review-form,.result-revision-form,.result-followup-form')){
  const saved=state[form.className+':'+form.dataset.result];if(!saved)continue;
  form.closest('details').open=saved.open;
  for(const element of form.elements)if(element.name&&Object.hasOwn(saved.values,element.name))element.value=saved.values[element.name];
 }
}
