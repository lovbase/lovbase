import { shq, type SandboxBackend } from './backend'

/** The watchdog runs INSIDE the container, so losing HTTP cannot orphan a build. */
export function boundedExecScript(script: string, budgetMs: number) {
  return `bun -e ${shq(`
    const {spawn}=require('node:child_process');
    const child=spawn('sh',['-lc',${JSON.stringify(script)}],{detached:true,stdio:'inherit'});
    let expired=false;
    const stop=()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}};
    const timer=setTimeout(()=>{expired=true;stop()},${Math.max(1, Math.trunc(budgetMs))});
    child.on('error',()=>{clearTimeout(timer);stop();process.exit(1)});
    child.on('close',code=>{clearTimeout(timer);stop();process.exit(expired?124:(code??1))});
  `)}`
}

export async function boundedExec(sb: SandboxBackend, script: string, budgetMs: number) {
  // The outer timeout is a transport backstop, not the mechanism that stops the process tree.
  return sb.exec(boundedExecScript(script, budgetMs), { timeoutMs: budgetMs + 10_000 })
}

/** Boris tools can spawn children outside its shell; terminate descendants before the agent. */
export function stopAgentScript(pidFile: string) {
  return `bun -e ${shq(`
    const fs=require('node:fs');
    let root;try{root=Number(fs.readFileSync(${JSON.stringify(pidFile)},'utf8').trim())}catch{process.exit(0)}
    if(!root || root<2)process.exit(0);
    const kill=(pid,signal)=>{try{process.kill(pid,signal)}catch{}};
    const stop=pid=>{
      kill(pid,'SIGSTOP');
      let children=[];
      try{children=fs.readFileSync('/proc/'+pid+'/task/'+pid+'/children','utf8').trim().split(/\\s+/).map(Number).filter(n=>n>1)}catch{}
      for(const child of children)stop(child);
      kill(pid,'SIGKILL');
    };
    stop(root);
    try{fs.unlinkSync(${JSON.stringify(pidFile)})}catch{}
  `)}`
}
