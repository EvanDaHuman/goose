// Credential-free public Git discovery, used when GitHub's unauthenticated REST quota is exhausted.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export type PublicRefs={defaultBranch:string;refs:Record<string,string>};
export function parsePublicRefs(text:string):PublicRefs{
 const refs:Record<string,string>=Object.create(null);let defaultBranch='';
 for(const line of text.split('\n')){
  const sym=line.match(/^ref: refs\/heads\/(.+)\tHEAD$/);if(sym){defaultBranch=sym[1];continue;}
  const match=line.match(/^([a-f0-9]{40})\t(HEAD|refs\/(?:heads|tags)\/.+)$/);if(match)refs[match[2]]=match[1];
 }
 if(!defaultBranch||!refs.HEAD)throw new Error('No public default branch found');
 return {defaultBranch,refs};
}
export function resolvePublicRef(refs:PublicRefs,name:string){
 return refs.refs[`refs/heads/${name}`]??refs.refs[`refs/tags/${name}^{}`]??refs.refs[`refs/tags/${name}`]??(name==='HEAD'?refs.refs.HEAD:undefined)??(/^[a-f0-9]{40}$/.test(name)?name:null);
}
const cache=new Map<string,{until:number;value:PublicRefs}>();
export async function readPublicRefs(ref:{owner:string;repo:string}):Promise<PublicRefs>{
 if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(ref.owner)||!/^[A-Za-z0-9._-]{1,100}$/.test(ref.repo)||['.','..'].includes(ref.repo))throw new Error('Invalid public repository');
 const url=`https://github.com/${ref.owner}/${ref.repo}.git`,hit=cache.get(url);if(hit&&hit.until>Date.now())return hit.value;
 const {stdout}=await execute('git',['-c','credential.helper=','-c','core.askPass=','ls-remote','--symref','--',url,'HEAD','refs/heads/*','refs/tags/*'],{
  cwd:'/tmp',timeout:30000,maxBuffer:2*1024*1024,encoding:'utf8',env:{NODE_ENV:'production',PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},
 });
 const value=parsePublicRefs(stdout);if(cache.size>=100)cache.clear();cache.set(url,{value,until:Date.now()+30000});return value;
}
