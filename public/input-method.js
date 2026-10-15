// Let the input method commit its candidate. Guard form submission separately.
// No text or key contents are stored; weak keys expire with their DOM fields.
export function bindInputMethodGuard(document,{now=()=>performance.now()}={}){
 const composing=new WeakSet(),ended=new WeakMap(),blocked=new WeakMap();
 const field=event=>event.target.closest('input,textarea');
 function start(event){const input=field(event);if(input)composing.add(input);}
 function end(event){const input=field(event);if(input){composing.delete(input);ended.set(input,now());}}
 function keydown(event){
  if(event.key!=='Enter')return;
  const input=field(event);if(!input?.form)return;
  const active=composing.has(input)||event.isComposing;
  // Some browsers end composition before delivering its confirmation key.
  const confirming=active||event.keyCode===229||now()-(ended.get(input)??-Infinity)<100;
  if(!confirming&&!event.repeat)return;
  blocked.set(input.form,now()+100);event.stopImmediatePropagation();
  // Preventing a live composing key's default can discard its candidate.
  if(!active)event.preventDefault();
 }
 function keyup(event){
  if(event.key!=='Enter')return;
  const input=field(event);if(!input?.form||!blocked.has(input.form))return;
  event.stopImmediatePropagation();if(!event.isComposing&&!composing.has(input))event.preventDefault();
  blocked.delete(input.form);ended.delete(input);
 }
 function submit(event){
  const form=event.target;
  if(!form.matches('form'))return;
  if([...form.elements].some(input=>composing.has(input))||(blocked.get(form)??0)>now()){
   event.preventDefault();event.stopImmediatePropagation();
  }
 }
 function pointer(event){
  const button=event.target.closest('button,input[type=submit]');if(!button?.form)return;
  blocked.delete(button.form);for(const input of button.form.elements)ended.delete(input);
 }
 const events={compositionstart:start,compositionend:end,keydown,keyup,submit,pointerdown:pointer};
 for(const [name,handler] of Object.entries(events))document.addEventListener(name,handler,true);
 return ()=>{for(const [name,handler] of Object.entries(events))document.removeEventListener(name,handler,true);};
}
