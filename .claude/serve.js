const http=require('http'),fs=require('fs'),path=require('path');
const root=__dirname+'/..';
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'};
http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html';
  const fp=path.join(root,p);
  fs.readFile(fp,(e,d)=>{ if(e){res.writeHead(404);res.end('nf');return;} res.writeHead(200,{'Content-Type':types[path.extname(fp)]||'application/octet-stream'});res.end(d);});
}).listen(8200,()=>console.log('serving on 8200'));
