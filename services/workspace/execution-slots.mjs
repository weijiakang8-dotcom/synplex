// At most one executor may actively compute. Human waiting yields its slot,
// then reacquires it before an answer is delivered to resume the original task.
export class ExecutionSlots {
  #occupied=false;
  #queue=[];
  acquire(signal){
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(signal.reason??new Error('Execution stopped'));return;}
      const item={resolve,reject,signal,abort:null};
      item.abort=()=>{this.#queue=this.#queue.filter(x=>x!==item);reject(signal.reason??new Error('Execution stopped'));};
      signal?.addEventListener('abort',item.abort,{once:true});
      this.#queue.push(item);this.#drain();
    });
  }
  #drain(){
    if(this.#occupied)return;
    const item=this.#queue.shift();if(!item)return;
    item.signal?.removeEventListener('abort',item.abort);this.#occupied=true;
    let released=false;
    item.resolve(()=>{if(released)return;released=true;this.#occupied=false;this.#drain();});
  }
}
