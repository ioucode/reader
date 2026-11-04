import type { Db } from '../db/index.ts';
import type { AppConfig } from '../config/index.ts';
import { badRequest, conflict } from '../lib/errors.ts';

export interface BusinessValues {
  ai:{enabled:boolean;scanEnabled:boolean;summaryEnabled:boolean;baseUrl:string;apiKey:string;model:string;scanPrompt:string;summaryPrompt:string;batchSize:number;maxInputChars:number};
  playback:{mode:'auto'|'direct'|'proxy'};
  tmdb:{enabled:boolean;token:string;apiKey:string;language:string};
  musicbrainz:{enabled:boolean;userAgent:string};
  tts:{enabled:boolean;protocol:'query'|'openai';url:string;token:string;model:string;voicesUrl:string;voiceList:string;timeoutMs:number;cacheMaxBytes:number};
  scanning:{interval:number;libraries:number;files:number;mediaAutoScan:boolean;mediaScrape:boolean;mediaEmbedded:boolean;mediaHidden:boolean};
  scraping:{timeoutMs:number;retries:number};
  access:{publicUrl:string;corsOrigins:string;accessTokenTtl:number;refreshTokenTtl:number};
  webdav:{url:string;username:string;password:string;maxBytes:number};
  library:{memberUpload:boolean};
  oidc:{enabled:boolean;buttonLabel:string;issuer:string;clientId:string;clientSecret:string;scopes:string;usernameClaim:string;userMap:string;autoCreate:boolean;adminGroup:string;passwordLogin:boolean};
}
export type SettingsGroup=keyof BusinessValues;
type Field={key:string;label:string;type:'text'|'textarea'|'password'|'number'|'checkbox'|'url'|'select';default:string|number|boolean;min?:number;max?:number;help?:string;options?:Array<{value:string;label:string}>};
export const SETTINGS_SCHEMA:Record<SettingsGroup,{label:string;fields:Field[]}>= {
  ai:{label:'AI 功能',fields:[
    {key:'enabled',label:'启用 AI',type:'checkbox',default:false},
    {key:'scanEnabled',label:'启用 AI 扫描',type:'checkbox',default:false},
    {key:'summaryEnabled',label:'启用 AI 总结',type:'checkbox',default:false},
    {key:'baseUrl',label:'Base URL',type:'url',default:'',help:'OpenAI 兼容接口地址，例如 https://api.openai.com/v1'},
    {key:'apiKey',label:'API Key',type:'password',default:''},
    {key:'model',label:'模型',type:'text',default:'',help:'填写地址和密钥后即可获取模型，无需先保存'},
    {key:'scanPrompt',label:'AI 扫描 Prompt',type:'textarea',default:'请根据以下媒体路径识别类型。必须返回 JSON 数组，每项包含 path、category（movie/series/music/audiobook/other）、title、year、season、artist、album。不要添加解释。'},
    {key:'summaryPrompt',label:'AI 总结 Prompt',type:'textarea',default:'请用中文总结以下章节内容，提炼主要情节、人物和关键信息，输出简洁连贯的段落。'},
    {key:'batchSize',label:'扫描批次大小',type:'number',default:500,min:20,max:1000},
    {key:'maxInputChars',label:'总结最大输入字符数',type:'number',default:60000,min:1000,max:500000},
  ]},
  playback:{label:'媒体播放',fields:[{key:'mode',label:'OpenList 播放方式',type:'select',default:'auto',options:[{value:'auto',label:'自动（直连优先，失败尝试代理）'},{value:'direct',label:'浏览器直连'},{value:'proxy',label:'服务器代理'}],help:'直连由浏览器访问临时下载地址，不经过 Reader 转发。仅服务器可访问的资源请选择代理；OpenList 自身的 Web 代理设置仍然有效。'}]},
  tmdb:{label:'TMDB',fields:[
    {key:'enabled',label:'启用 TMDB',type:'checkbox',default:false},
    {key:'token',label:'读取令牌',type:'password',default:''},
    {key:'apiKey',label:'API Key（未填令牌时使用）',type:'password',default:''},
    {key:'language',label:'资料语言',type:'text',default:'zh-CN',help:'例如 zh-CN、zh-TW、en-US'},
  ]},
  musicbrainz:{label:'MusicBrainz',fields:[
    {key:'enabled',label:'启用 MusicBrainz',type:'checkbox',default:false},
    {key:'userAgent',label:'应用标识与联系地址',type:'text',default:'',help:'例如 Reader/0.1 (mailto:admin@example.com)'},
  ]},
  tts:{label:'HTTP 朗读',fields:[
    {key:'enabled',label:'启用 HTTP 朗读',type:'checkbox',default:false},
    {key:'protocol',label:'接口协议',type:'select',default:'query',options:[{value:'query',label:'查询参数（GET ?text=&voice=&speed=）'},{value:'openai',label:'OpenAI 兼容（POST /audio/speech）'}],help:'OpenAI 兼容：填 Base URL（如 https://api.openai.com/v1）或完整的 …/audio/speech 地址'},
    {key:'url',label:'语音合成接口',type:'url',default:'',help:'查询参数协议：兼容 text、voice、speed 查询参数；地址须能从服务器访问'},
    {key:'token',label:'认证令牌',type:'password',default:''},
    {key:'model',label:'模型（OpenAI 兼容）',type:'text',default:'',help:'例如 tts-1、gpt-4o-mini-tts；留空时使用 tts-1'},
    {key:'voicesUrl',label:'音色列表接口（可选）',type:'url',default:'',help:'返回 JSON 数组或 {voices:[…]}，每项含 id、name、lang'},
    {key:'voiceList',label:'音色列表（可选）',type:'textarea',default:'',help:'每行一个：音色ID 或 音色ID|显示名称。未配置列表接口时使用；OpenAI 兼容协议都未配置时提供 OpenAI 内置音色'},
    {key:'timeoutMs',label:'请求超时（毫秒）',type:'number',default:20000,min:100,max:120000},
    {key:'cacheMaxBytes',label:'音频缓存上限（字节，0 关闭）',type:'number',default:268435456,min:0,max:10737418240},
  ]},
  scanning:{label:'扫描设置',fields:[
    {key:'interval',label:'阅读书库自动检查间隔（秒，0 关闭）',type:'number',default:60,min:0,max:604800,help:'统一原定时扫描与变化检查；保存后重新计时'},
    {key:'libraries',label:'同时扫描的媒体库数',type:'number',default:2,min:1,max:4},
    {key:'files',label:'远端文件处理并发数',type:'number',default:4,min:1,max:8},
    {key:'mediaAutoScan',label:'自动扫描新文件',type:'checkbox',default:true,help:'影音库每小时检查一次新增和变化的文件'},
    {key:'mediaScrape',label:'刮削封面与简介',type:'checkbox',default:false,help:'扫描完成后，用已配置的 TMDB 或 MusicBrainz 为还没有在线资料的作品刮削'},
    {key:'mediaEmbedded',label:'读取内嵌字幕与歌词',type:'checkbox',default:true},
    {key:'mediaHidden',label:'扫描隐藏文件夹',type:'checkbox',default:false,help:'名称以“.”开头的文件夹和文件；关闭后它们在下次扫描时视为不存在'},
  ]},
  scraping:{label:'刮削高级设置',fields:[
    {key:'timeoutMs',label:'请求超时（毫秒）',type:'number',default:12000,min:1000,max:120000},
    {key:'retries',label:'失败重试次数',type:'number',default:2,min:0,max:3},
  ]},
  access:{label:'登录与服务访问',fields:[
    {key:'publicUrl',label:'对外服务地址',type:'url',default:''},
    {key:'corsOrigins',label:'允许的浏览器来源',type:'text',default:'',help:'多个来源以逗号分隔；留空允许任意来源'},
    {key:'accessTokenTtl',label:'访问令牌有效期（秒）',type:'number',default:604800,min:300,max:31536000},
    {key:'refreshTokenTtl',label:'登录续期有效期（秒）',type:'number',default:31536000,min:3600,max:157680000},
  ]},
  webdav:{label:'WebDAV 备份',fields:[
    {key:'url',label:'备份目录地址',type:'url',default:'',help:'使用 HTTPS；仅本机调试允许 HTTP'},
    {key:'username',label:'账号',type:'text',default:''},
    {key:'password',label:'密码',type:'password',default:''},
    {key:'maxBytes',label:'单次上传上限（字节）',type:'number',default:2147483648,min:1,max:4294967295},
  ]},
  oidc:{label:'OIDC 单点登录',fields:[
    {key:'enabled',label:'启用 OIDC 登录',type:'checkbox',default:false,help:'回调地址：<对外服务地址>/api/v1/auth/oidc/callback（须先在「登录与服务访问」填写对外服务地址）'},
    {key:'buttonLabel',label:'登录按钮文字',type:'text',default:'使用统一认证登录'},
    {key:'issuer',label:'Issuer 地址',type:'url',default:'',help:'例如 https://auth.example.com/application/o/reader/ ，服务器会读取其 /.well-known/openid-configuration'},
    {key:'clientId',label:'Client ID',type:'text',default:''},
    {key:'clientSecret',label:'Client Secret',type:'password',default:''},
    {key:'scopes',label:'Scopes',type:'text',default:'openid profile email'},
    {key:'usernameClaim',label:'用户名声明',type:'text',default:'preferred_username',help:'用于对应本地账号和自动创建账号的声明，常用 preferred_username 或 email'},
    {key:'userMap',label:'账号对应关系',type:'textarea',default:'',help:'每行一条：OIDC用户名=本地用户名。首次登录时按此关联已有账号，关联后以 OIDC 的 sub 为准'},
    {key:'autoCreate',label:'自动创建账号',type:'checkbox',default:false,help:'没有对应关系的 OIDC 用户首次登录时创建成员账号；关闭时只允许已对应的账号登录'},
    {key:'adminGroup',label:'管理员组（可选）',type:'text',default:'',help:'groups 声明包含此组的用户登录时提升为管理员（不会自动降级）'},
    {key:'passwordLogin',label:'保留密码登录',type:'checkbox',default:true,help:'关闭后登录页只显示 OIDC 按钮；接口仍接受密码登录以便应急'},
  ]},
  library:{label:'书库',fields:[
    {key:'memberUpload',label:'允许成员上传书籍',type:'checkbox',default:true,help:'成员只能新增支持格式的书籍文件：不解包压缩包、不覆盖已有文件。改名、移动、删除和新建目录始终仅限管理员'},
  ]},
};
export function settingsDefaults<K extends SettingsGroup>(group:K):BusinessValues[K]{
  return Object.fromEntries(SETTINGS_SCHEMA[group].fields.map(field=>[field.key,field.default])) as BusinessValues[K];
}
export class BusinessSettingsReader {
  constructor(protected readonly db:Pick<Db,'get'>){}
  read<K extends SettingsGroup>(group:K):BusinessValues[K]{
    const row=this.db.get<{value:string}>('SELECT value FROM business_settings WHERE name=?',group);
    return {...settingsDefaults(group),...(row?JSON.parse(row.value):{})};
  }
}
export class BusinessSettings extends BusinessSettingsReader {
  constructor(private readonly database:Db,config:AppConfig){
    super(database);
    database.transaction(()=>{
      for(const group of Object.keys(SETTINGS_SCHEMA) as SettingsGroup[]){
        if(!database.get('SELECT name FROM business_settings WHERE name=?',group)){
          const initial=legacySettings(group,config);
          database.run('INSERT INTO business_settings(name,value,revision) VALUES(?,?,1)',group,JSON.stringify(initial));
        }
      }
    });
    this.apply(config);
  }
  apply(config:AppConfig){
    const access=this.read('access');
    Object.assign(config,{publicUrl:access.publicUrl,corsOrigins:access.corsOrigins.split(',').map(value=>value.trim()).filter(Boolean),accessTokenTtl:access.accessTokenTtl,refreshTokenTtl:access.refreshTokenTtl});
  }
  view(group:SettingsGroup){
    const values={...this.read(group)} as Record<string,unknown>,secrets:Record<string,boolean>={};
    for(const field of SETTINGS_SCHEMA[group].fields)if(field.type==='password'){secrets[field.key]=!!values[field.key];delete values[field.key];}
    return {group,...SETTINGS_SCHEMA[group],values,secrets,revision:this.database.get<{revision:number}>('SELECT revision FROM business_settings WHERE name=?',group)!.revision};
  }
  candidate<K extends SettingsGroup>(group:K,input:unknown):BusinessValues[K]{
    if(!input||typeof input!=='object'||Array.isArray(input))throw badRequest('配置必须是对象');
    const patch=input as Record<string,unknown>,values={...this.read(group)} as Record<string,unknown>;
    for(const [key,value] of Object.entries(patch)){
      const field=SETTINGS_SCHEMA[group].fields.find(field=>field.key===key);
      if(!field)throw badRequest('未知配置项');
      if(field.type==='checkbox'){if(typeof value!=='boolean')throw badRequest(`${field.label}格式无效`);}
      else if(field.type==='number'){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<field.min!||value>field.max!)throw badRequest(`${field.label}须在 ${field.min}–${field.max} 之间`);}
      else if(typeof value!=='string'||value.length>4096||(field.type==='textarea'?/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/:/[\u0000-\u001f\u007f]/).test(value))throw badRequest(`${field.label}格式无效`);
      if(field.type==='select'&&!field.options?.some(option=>option.value===value))throw badRequest(`${field.label}选项无效`);
      if(group==='ai'&&key==='apiKey'&&field.type==='password'&&value==='') continue;
      values[key]=typeof value==='string'&&field.type!=='password'?value.trim():value;
      if(field.type==='url'&&values[key])validateUrl(String(values[key]));
    }
    if(group==='tmdb'){
      if(values.enabled&&!values.token&&!values.apiKey)throw badRequest('启用 TMDB 前请填写令牌或 API Key');
      if(!/^[a-z]{2,3}(?:-[a-zA-Z]{2,4})?$/.test(String(values.language)))throw badRequest('无效的资料语言');
    }
    if(group==='musicbrainz'&&values.enabled&&!/\S+\/\S+.*(?:@|https?:\/\/)/.test(String(values.userAgent)))throw badRequest('请填写应用名称/版本及有效联系地址');
    if(group==='oidc'&&values.enabled&&(!values.issuer||!values.clientId))throw badRequest('启用 OIDC 前请填写 Issuer 地址和 Client ID');
    if(group==='tts'&&values.enabled&&!values.url)throw badRequest('启用 HTTP 朗读前请填写接口地址');
    if(group==='ai'&&values.enabled&&(!values.baseUrl||!values.apiKey||!values.model))throw badRequest('启用 AI 前请填写 Base URL、API Key 和模型');
    if(group==='access'){
      for(const origin of String(values.corsOrigins).split(',').map(value=>value.trim()).filter(Boolean))if(origin!=='null'&&validateUrl(origin).origin!==origin)throw badRequest('浏览器来源须为协议与域名（可含端口），不能包含路径');
      if(Number(values.refreshTokenTtl)<Number(values.accessTokenTtl))throw badRequest('登录续期有效期不能小于访问令牌有效期');
    }
    if(group==='webdav'&&values.url){
      const url=validateUrl(String(values.url));
      if(url.search||url.hash||(url.protocol!=='https:'&&!['127.0.0.1','[::1]','localhost'].includes(url.hostname)))throw badRequest('WebDAV 必须使用 HTTPS 目录地址，且不能包含查询参数');
      if(String(values.username).includes(':'))throw badRequest('WebDAV 账号不能包含冒号');
    }
    return values as unknown as BusinessValues[K];
  }
  save(group:SettingsGroup,input:unknown,revision:unknown){
    return this.database.transaction(()=>{
      const current=this.view(group);
      if(revision!==current.revision)throw conflict('配置已被其他管理员修改，请重新加载后保存','SETTINGS_CONFLICT');
      const values=this.candidate(group,input);
      this.database.run('UPDATE business_settings SET value=?,revision=revision+1 WHERE name=?',JSON.stringify(values),group);
      return this.view(group);
    });
  }
}
function validateUrl(value:string){
  let url:URL;try{url=new URL(value);}catch{throw badRequest('请输入有效的 HTTP 或 HTTPS 地址');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw badRequest('地址不能包含账号、密码、片段或其他协议');
  return url;
}
/** Called only for missing database rows: clearing a page field never revives env values. */
function legacySettings<K extends SettingsGroup>(group:K,config:AppConfig):BusinessValues[K]{
  const env=process.env,text=(name:string)=>env[name]?.trim()||'';
  const integer=(name:string,fallback:number)=>{const value=Number(env[name]);return env[name]&&Number.isSafeInteger(value)&&value>=0?value:fallback;};
  const intervals=[config.scanInterval,config.watchInterval].filter(value=>value>0);
  const legacy:Partial<BusinessValues>={
    ai:{enabled:false,scanEnabled:false,summaryEnabled:false,baseUrl:text('AI_BASE_URL'),apiKey:text('AI_API_KEY'),model:text('AI_MODEL'),scanPrompt:'请根据以下媒体路径识别类型。必须返回 JSON 数组，每项包含 path、category（movie/series/music/audiobook/other）、title、year、season、artist、album。不要添加解释。',summaryPrompt:'请用中文总结以下章节内容，提炼主要情节、人物和关键信息，输出简洁连贯的段落。',batchSize:500,maxInputChars:60000},
    tmdb:{enabled:!!(text('MEDIA_TMDB_TOKEN')||text('MEDIA_TMDB_API_KEY')),token:text('MEDIA_TMDB_TOKEN'),apiKey:text('MEDIA_TMDB_API_KEY'),language:'zh-CN'},
    musicbrainz:{enabled:!!text('MEDIA_MUSICBRAINZ_USER_AGENT'),userAgent:text('MEDIA_MUSICBRAINZ_USER_AGENT')},
    tts:{enabled:!!text('TTS_URL'),protocol:text('TTS_PROTOCOL')==='openai'?'openai':'query',url:text('TTS_URL'),token:text('TTS_TOKEN'),model:text('TTS_MODEL'),voicesUrl:text('TTS_VOICES_URL'),voiceList:text('TTS_VOICES'),timeoutMs:integer('TTS_TIMEOUT_MS',20000),cacheMaxBytes:integer('TTS_CACHE_BYTES',268435456)},
    scanning:{interval:intervals.length?Math.min(...intervals):0,libraries:2,files:4,mediaAutoScan:true,mediaScrape:false,mediaEmbedded:true,mediaHidden:false},
    access:{publicUrl:config.publicUrl,corsOrigins:config.corsOrigins.join(','),accessTokenTtl:config.accessTokenTtl,refreshTokenTtl:config.refreshTokenTtl},
    webdav:{url:text('WEBDAV_URL'),username:text('WEBDAV_USERNAME'),password:text('WEBDAV_PASSWORD'),maxBytes:integer('WEBDAV_MAX_BYTES',2147483648)},
  };
  const result=(legacy[group]??settingsDefaults(group)) as unknown as Record<string,unknown>;
  for(const field of SETTINGS_SCHEMA[group].fields){
    if(field.type==='number'&&(!Number.isSafeInteger(result[field.key])||Number(result[field.key])<field.min!||Number(result[field.key])>field.max!))result[field.key]=field.default;
  }
  return result as unknown as BusinessValues[K];
}
