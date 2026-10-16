export const ACCOUNT_PATHS={login:'/login',register:'/register',reset:'/forgot-password'};
export function accountMode(location){
 const path=location.pathname.replace(/\/$/,'');
 const matched=Object.keys(ACCOUNT_PATHS).find(mode=>ACCOUNT_PATHS[mode]===path);
 if(matched)return matched;
 const legacy=new URLSearchParams(location.search).get('account');
 return ['register','reset'].includes(legacy)?legacy:'login';
}
export function isAccountPage(location){
 return Object.values(ACCOUNT_PATHS).includes(location.pathname.replace(/\/$/,''))||new URLSearchParams(location.search).has('account');
}
