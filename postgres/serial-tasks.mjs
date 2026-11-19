// Independent per-instance queues: a failure does not poison subsequent operations.
export function createSerialTasks(){
  const tails=new Map();
  function run(key,operation){
    const task=(tails.get(key)||Promise.resolve()).then(operation);
    const settled=task.then(()=>{},()=>{});tails.set(key,settled);
    void settled.then(()=>{if(tails.get(key)===settled)tails.delete(key);});
    return task;
  }
  const idle=async key=>{if(key!==undefined)await tails.get(key);else await Promise.all([...tails.values()]);};
  return {run,idle,size:()=>tails.size};
}
