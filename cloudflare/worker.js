/**
 * Private blog publishing API for MOHANNED SABER.
 * Deploy as a Cloudflare Worker. Required secrets/vars are documented in
 * cloudflare/SETUP.md. Never commit secret values.
 */
const COOKIE = "ms_blog_session";
const STATE_COOKIE = "ms_blog_oauth_state";
const SESSION_SECONDS = 8 * 60 * 60;
const API_VERSION = "2022-11-28";

function cors(origin, env) {
  const allowed = env.SITE_ORIGIN;
  if (origin !== allowed) return {};
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Vary": "Origin"
  };
}
function json(data, status=200, headers={}) {
  return new Response(JSON.stringify(data), {status,headers:{"Content-Type":"application/json; charset=utf-8",...headers}});
}
function cookie(name,value,maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function clearCookie(name) { return cookie(name,"",0); }
function getCookie(request,name) {
  const raw=request.headers.get("Cookie")||"";
  const entry=raw.split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="));
  return entry ? entry.slice(name.length+1) : "";
}
function randomToken(bytes=32) {
  const b=crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
}
function b64ToBytes(value) {
  const normalized=value.replaceAll("-","+").replaceAll("_","/");
  const binary=atob(normalized+"=".repeat((4-normalized.length%4)%4));
  return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
async function sessionKey(env) {
  const raw=b64ToBytes(env.SESSION_ENCRYPTION_KEY);
  if(raw.length!==32) throw new Error("SESSION_ENCRYPTION_KEY must be base64 for 32 random bytes");
  return crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function seal(value,env) {
  const key=await sessionKey(env),iv=crypto.getRandomValues(new Uint8Array(12));
  const data=new TextEncoder().encode(JSON.stringify(value));
  const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,data);
  const joined=new Uint8Array(iv.length+encrypted.byteLength);joined.set(iv);joined.set(new Uint8Array(encrypted),iv.length);
  return btoa(String.fromCharCode(...joined)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
}
async function openSession(request,env) {
  try {
    const value=getCookie(request,COOKIE);if(!value)return null;
    const raw=b64ToBytes(value),iv=raw.slice(0,12),cipher=raw.slice(12);
    const key=await sessionKey(env);
    const decrypted=await crypto.subtle.decrypt({name:"AES-GCM",iv},key,cipher);
    const session=JSON.parse(new TextDecoder().decode(decrypted));
    if(!session.exp||session.exp<Date.now()||session.login!==env.ALLOWED_GITHUB_USERNAME)return null;
    return session;
  } catch { return null; }
}
async function github(path,token,options={}) {
  const response=await fetch("https://api.github.com"+path,{...options,headers:{
    "Accept":"application/vnd.github+json","Authorization":"Bearer "+token,
    "X-GitHub-Api-Version":API_VERSION,"User-Agent":"Mohanned-Blog-CMS",
    ...(options.headers||{})
  }});
  return response;
}
function validSlug(slug) { return /^[a-z0-9]+(?:-[a-z0-9]+){0,8}$/.test(slug)&&slug.length<=80; }
function safeText(value,max) { return typeof value==="string"&&value.trim().length>0&&value.length<=max; }
function yamlQuote(value) { return JSON.stringify(value); }

export default {
  async fetch(request,env) {
    const url=new URL(request.url),origin=request.headers.get("Origin")||"";
    const headers=cors(origin,env);
    if(request.method==="OPTIONS") return new Response(null,{status:204,headers});
    if(origin && origin!==env.SITE_ORIGIN) return json({error:"Origin not allowed"},403);
    if(url.pathname==="/auth/login"&&request.method==="GET") {
      const state=randomToken(24);
      const callback=env.WORKER_ORIGIN+"/auth/callback";
      const target="https://github.com/login/oauth/authorize?"+new URLSearchParams({
        client_id:env.GITHUB_CLIENT_ID,redirect_uri:callback,scope:"public_repo",state
      });
      return Response.redirect(target,302);
    }
    if(url.pathname==="/auth/callback"&&request.method==="GET") {
      const state=url.searchParams.get("state")||"";
      const saved=getCookie(request,STATE_COOKIE);
      // State is placed in a short-lived HttpOnly cookie by /auth/start below.
      if(!state||!saved||state!==saved) return new Response("OAuth state validation failed.",{status:400});
      const code=url.searchParams.get("code");if(!code)return new Response("Missing OAuth code.",{status:400});
      const tokenResponse=await fetch("https://github.com/login/oauth/access_token",{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/json"},body:JSON.stringify({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,code,redirect_uri:env.WORKER_ORIGIN+"/auth/callback"})});
      const tokenData=await tokenResponse.json();if(!tokenData.access_token)return new Response("GitHub authorization failed.",{status:401});
      const profileResponse=await github("/user",tokenData.access_token);const profile=await profileResponse.json();
      if(profile.login!==env.ALLOWED_GITHUB_USERNAME)return new Response("This GitHub account is not authorized.",{status:403});
      const session=await seal({token:tokenData.access_token,login:profile.login,exp:Date.now()+SESSION_SECONDS*1000},env);
      return new Response(null,{status:302,headers:{"Location":env.SITE_ORIGIN+"/admin/","Set-Cookie":cookie(COOKIE,session,SESSION_SECONDS)+"\n"+clearCookie(STATE_COOKIE)}});
    }
    if(url.pathname==="/auth/start"&&request.method==="GET") {
      const state=randomToken(24);
      const target="https://github.com/login/oauth/authorize?"+new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,redirect_uri:env.WORKER_ORIGIN+"/auth/callback",scope:"public_repo",state});
      return new Response(null,{status:302,headers:{"Location":target,"Set-Cookie":cookie(STATE_COOKIE,state,300)}});
    }
    if(url.pathname==="/auth/logout"&&request.method==="POST") return json({ok:true},200,{"Set-Cookie":clearCookie(COOKIE)});
    if(url.pathname==="/api/me"&&request.method==="GET") {
      const session=await openSession(request,env);
      return json(session?{authenticated:true,login:session.login}:{authenticated:false},session?200:401,headers);
    }
    if(url.pathname==="/api/posts"&&request.method==="POST") {
      const session=await openSession(request,env);if(!session)return json({error:"Authentication required"},401,headers);
      let body;try{body=await request.json();}catch{return json({error:"Invalid JSON"},400,headers);}
      const {title,slug,description,tags,content}=body||{};
      if(!safeText(title,140)||!validSlug(slug)||!safeText(description,260)||!safeText(content,50000)||content.trim().length<80)
        return json({error:"Check title, slug, description and article content (at least 80 characters)."},400,headers);
      const cleanTags=Array.isArray(tags)?tags.slice(0,8).filter(t=>typeof t==="string"&&/^[a-zA-Z0-9 -]{1,30}$/.test(t)): [];
      const now=new Date(),date=now.toISOString().slice(0,10);
      const path=`_posts/${date}-${slug}.md`;
      const frontmatter=`---\nlayout: post\ntitle: ${yamlQuote(title.trim())}\ndescription: ${yamlQuote(description.trim())}\ndate: ${date} ${now.toISOString().slice(11,19)} +0000\npermalink: /blog/posts/${slug}/\ntags: [${cleanTags.map(yamlQuote).join(", ")}]\n---\n\n`;
      const contentFile=frontmatter+content.trim()+"\n";
      const check=await github(`/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}`,session.token);
      let sha;
      if(check.status===200){const existing=await check.json();sha=existing.sha;}
      else if(check.status!==404)return json({error:"Could not check existing article."},502,headers);
      const response=await github(`/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}`,session.token,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:(sha?"Update":"Publish")+" blog post: "+slug,content:btoa(unescape(encodeURIComponent(contentFile))),branch:env.REPO_BRANCH||"main",...(sha?{sha}:{})})});
      const result=await response.json();if(!response.ok)return json({error:"GitHub could not save the article.",details:result.message},502,headers);
      return json({ok:true,path,url:env.SITE_ORIGIN+"/blog/posts/"+slug+"/",commit:result.commit?.html_url},201,headers);
    }
    return json({error:"Not found"},404,headers);
  }
};
