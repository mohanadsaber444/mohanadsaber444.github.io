/**
 * Private blog CMS API.
 * GitHub OAuth verifies the owner; a repository-scoped GitHub App publishes posts.
 * Deploy with Wrangler and the assets binding in wrangler.toml.
 */
const COOKIE = "ms_blog_session";
const STATE_COOKIE = "ms_blog_oauth_state";
const SESSION_SECONDS = 8 * 60 * 60;
const API_VERSION = "2022-11-28";

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.WORKER_ORIGIN,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Vary": "Origin"
  };
}
function json(data,status=200,headers={}) {
  return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8",...headers}});
}
function cookie(name,value,maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function clearCookie(name) { return cookie(name,"",0); }
function getCookie(request,name) {
  const entry=(request.headers.get("Cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="));
  return entry?entry.slice(name.length+1):"";
}
function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
}
function randomToken(bytes=32) { return b64url(crypto.getRandomValues(new Uint8Array(bytes))); }
function decodeB64url(value) {
  const s=value.replaceAll("-","+").replaceAll("_","/");
  const binary=atob(s+"=".repeat((4-s.length%4)%4));
  return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
async function sessionKey(env) {
  const raw=decodeB64url(env.SESSION_ENCRYPTION_KEY);
  if(raw.length!==32) throw new Error("SESSION_ENCRYPTION_KEY must encode 32 random bytes");
  return crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function seal(value,env) {
  const key=await sessionKey(env),iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(JSON.stringify(value)));
  const joined=new Uint8Array(iv.length+encrypted.byteLength);joined.set(iv);joined.set(new Uint8Array(encrypted),iv.length);
  return b64url(joined);
}
async function openSession(request,env) {
  try {
    const value=getCookie(request,COOKIE);if(!value)return null;
    const raw=decodeB64url(value),iv=raw.slice(0,12),cipher=raw.slice(12);
    const key=await sessionKey(env);
    const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv},key,cipher);
    const session=JSON.parse(new TextDecoder().decode(plain));
    return session.exp>Date.now()&&session.login===env.ALLOWED_GITHUB_USERNAME?session:null;
  } catch { return null; }
}
async function github(path,token,options={}) {
  return fetch("https://api.github.com"+path,{...options,headers:{
    "Accept":"application/vnd.github+json","Authorization":"Bearer "+token,
    "X-GitHub-Api-Version":API_VERSION,"User-Agent":"Mohanned-Blog-CMS",
    ...(options.headers||{})
  }});
}
function validSlug(slug) { return typeof slug==="string"&&slug.length<=80&&/^[a-z0-9]+(?:-[a-z0-9]+){0,8}$/.test(slug); }
function safeText(value,max) { return typeof value==="string"&&value.trim().length>0&&value.length<=max; }
function yamlQuote(value) { return JSON.stringify(value); }
function utf8Base64(value) { return btoa(String.fromCharCode(...new TextEncoder().encode(value))); }
function pemBytes(pem) {
  const body=pem.replace(/\\n/g,"\n").replace(/-----BEGIN PRIVATE KEY-----/g,"").replace(/-----END PRIVATE KEY-----/g,"").replace(/\s/g,"");
  const binary=atob(body);return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
async function appJwt(env) {
  const now=Math.floor(Date.now()/1000);
  const header=b64url(new TextEncoder().encode(JSON.stringify({alg:"RS256",typ:"JWT"})));
  const payload=b64url(new TextEncoder().encode(JSON.stringify({iat:now-30,exp:now+540,iss:env.GITHUB_APP_ID})));
  const unsigned=header+"."+payload;
  const key=await crypto.subtle.importKey("pkcs8",pemBytes(env.GITHUB_APP_PRIVATE_KEY),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
  const signature=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(unsigned));
  return unsigned+"."+b64url(new Uint8Array(signature));
}
async function installationToken(env) {
  const jwt=await appJwt(env);
  const response=await fetch(`https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,{
    method:"POST",headers:{"Accept":"application/vnd.github+json","Authorization":"Bearer "+jwt,"X-GitHub-Api-Version":API_VERSION,"Content-Type":"application/json","User-Agent":"Mohanned-Blog-CMS"},
    body:JSON.stringify({repositories:[env.REPO_NAME],permissions:{contents:"write"}})
  });
  const data=await response.json();if(!response.ok||!data.token)throw new Error("GitHub App could not create a repository installation token");
  return data.token;
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url),origin=request.headers.get("Origin")||"",headers=cors(env);
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers});
    if(origin&&origin!==env.WORKER_ORIGIN)return json({error:"Origin not allowed"},403);
    if(request.method==="POST"&&origin!==env.WORKER_ORIGIN)return json({error:"Request origin required"},403);
    if(url.pathname==="/auth/start"&&request.method==="GET") {
      const state=randomToken(24);
      const target="https://github.com/login/oauth/authorize?"+new URLSearchParams({
        client_id:env.GITHUB_CLIENT_ID,redirect_uri:env.WORKER_ORIGIN+"/auth/callback",state
      });
      return new Response(null,{status:302,headers:{"Location":target,"Set-Cookie":cookie(STATE_COOKIE,state,300)}});
    }
    if(url.pathname==="/auth/callback"&&request.method==="GET") {
      const state=url.searchParams.get("state")||"",saved=getCookie(request,STATE_COOKIE);
      if(!state||!saved||state!==saved)return new Response("OAuth state validation failed.",{status:400});
      const code=url.searchParams.get("code");if(!code)return new Response("Missing OAuth code.",{status:400});
      const tokenResponse=await fetch("https://github.com/login/oauth/access_token",{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/json"},body:JSON.stringify({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,code,redirect_uri:env.WORKER_ORIGIN+"/auth/callback"})});
      const tokenData=await tokenResponse.json();if(!tokenData.access_token)return new Response("GitHub authorization failed.",{status:401});
      const profileResponse=await github("/user",tokenData.access_token),profile=await profileResponse.json();
      if(profile.login!==env.ALLOWED_GITHUB_USERNAME)return new Response("This GitHub account is not authorized.",{status:403});
      const session=await seal({login:profile.login,exp:Date.now()+SESSION_SECONDS*1000},env);
      const responseHeaders=new Headers({"Location":env.WORKER_ORIGIN+"/"});
      responseHeaders.append("Set-Cookie",cookie(COOKIE,session,SESSION_SECONDS));
      responseHeaders.append("Set-Cookie",clearCookie(STATE_COOKIE));
      return new Response(null,{status:302,headers:responseHeaders});
    }
    if(url.pathname==="/auth/logout"&&request.method==="POST") {
      const h=new Headers(headers);h.append("Set-Cookie",clearCookie(COOKIE));
      return new Response(JSON.stringify({ok:true}),{status:200,headers:new Headers([...h.entries(),["Content-Type","application/json; charset=utf-8"]])});
    }
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
      const now=new Date(),date=now.toISOString().slice(0,10),path=`_posts/${date}-${slug}.md`;
      const listing=await github(`/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/_posts?ref=${encodeURIComponent(env.REPO_BRANCH||"main")}`,await installationToken(env));
      let files=[];
      if(listing.status===200)files=await listing.json();
      else if(listing.status!==404)return json({error:"Could not check existing article slugs."},502,headers);
      const collision=Array.isArray(files)&&files.find(f=>f.name.endsWith("-"+slug+".md")&&f.path!==path);
      if(collision)return json({error:"This slug is already used. Choose a unique slug."},409,headers);
      const check=await github(`/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}?ref=${encodeURIComponent(env.REPO_BRANCH||"main")}`,await installationToken(env));
      let sha;if(check.status===200)sha=(await check.json()).sha;else if(check.status!==404)return json({error:"Could not check article path."},502,headers);
      const frontmatter=`---\nlayout: post\ntitle: ${yamlQuote(title.trim())}\ndescription: ${yamlQuote(description.trim())}\ndate: ${date} ${now.toISOString().slice(11,19)} +0000\npermalink: /blog/posts/${slug}/\ntags: [${cleanTags.map(yamlQuote).join(", ")}]\n---\n\n`;
      const contentFile=frontmatter+content.trim()+"\n";
      const token=await installationToken(env);
      const response=await github(`/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}`,token,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:(sha?"Update":"Publish")+" blog post: "+slug,content:utf8Base64(contentFile),branch:env.REPO_BRANCH||"main",...(sha?{sha}:{})})});
      const result=await response.json();if(!response.ok)return json({error:"GitHub could not save the article.",details:result.message},502,headers);
      return json({ok:true,path,url:env.SITE_ORIGIN+"/blog/posts/"+slug+"/",commit:result.commit?.html_url},201,headers);
    }
    if(env.ASSETS)return env.ASSETS.fetch(request);
    return json({error:"Not found"},404,headers);
  }
};
