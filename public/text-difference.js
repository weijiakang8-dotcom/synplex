// Bounded, deterministic line comparison. Source text is never executed.
const MAX_TEXT_BYTES=256*1024,MAX_LINES=4000,MAX_CELLS=1_000_000;
function commonEdges(a,b){
 let prefix=0,suffix=0;
 while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
 while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
 return {prefix,suffix};
}
function lengths(left,right){
 const rows=Array.from({length:left.length+1},()=>new Uint16Array(right.length+1));
 for(let i=left.length-1;i>=0;i--)for(let j=right.length-1;j>=0;j--)rows[i][j]=left[i]===right[j]?rows[i+1][j+1]+1:Math.max(rows[i+1][j],rows[i][j+1]);
 return rows;
}
function middleRows(left,right,prefix){
 const rows=lengths(left,right),changes=[];let i=0,j=0;
 while(i<left.length||j<right.length){
  if(i<left.length&&j<right.length&&left[i]===right[j]){changes.push({kind:'same',text:left[i],beforeLine:prefix+i+1,afterLine:prefix+j+1});i++;j++;}
  else if(j<right.length&&(i===left.length||rows[i][j+1]>rows[i+1][j])){changes.push({kind:'added',text:right[j],beforeLine:null,afterLine:prefix+j+1});j++;}
  else{changes.push({kind:'removed',text:left[i],beforeLine:prefix+i+1,afterLine:null});i++;}
 }
 return changes;
}
export function textDifference(before,after){
 if(new TextEncoder().encode(before).length>MAX_TEXT_BYTES||new TextEncoder().encode(after).length>MAX_TEXT_BYTES)return {status:'limited',notice:'文字较长，请下载两版文件比较；这里没有省略内容后冒充完整比较。'};
 const a=before.split('\n'),b=after.split('\n');
 if(a.length+b.length>MAX_LINES)return {status:'limited',notice:'文字行数较多，请下载两版文件比较。'};
 const {prefix,suffix}=commonEdges(a,b),left=a.slice(prefix,a.length-suffix),right=b.slice(prefix,b.length-suffix);
 if((left.length+1)*(right.length+1)>MAX_CELLS)return {status:'limited',notice:'变化范围较大，请下载两版文件比较；原文件仍完整保留。'};
 const changes=middleRows(left,right,prefix);
 const leading=a.slice(Math.max(0,prefix-2),prefix).map((text,k)=>({kind:'same',text,beforeLine:Math.max(0,prefix-2)+k+1,afterLine:Math.max(0,prefix-2)+k+1}));
 const trailing=a.slice(a.length-suffix,a.length-suffix+2).map((text,k)=>({kind:'same',text,beforeLine:a.length-suffix+k+1,afterLine:b.length-suffix+k+1}));
 return {status:'complete',sameText:before===after,added:changes.filter(r=>r.kind==='added').length,removed:changes.filter(r=>r.kind==='removed').length,
  rows:before===after?[]:[...leading,...changes,...trailing],omittedUnchangedBefore:Math.max(0,prefix-2),omittedUnchangedAfter:Math.max(0,suffix-2),
  beforeEndsWithNewline:before.endsWith('\n'),afterEndsWithNewline:after.endsWith('\n')};
}
