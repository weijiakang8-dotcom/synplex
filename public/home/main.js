import {startGalaxy} from './galaxy.js';

const modal=document.querySelector('#tools');document.querySelector('#connect-tools').addEventListener('click',()=>modal.showModal());modal.querySelector('.close').addEventListener('click',()=>modal.close());modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close()}});
startGalaxy(document.querySelector('#stars'));
