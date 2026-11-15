import React,{useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {floatingPosition} from '../lib/floatingPosition';
export default function FloatingInfo({x,y,children,className='a-tip',onDismiss,gap=14}) {
  const ref=useRef(null),[pos,setPos]=useState(null);
  useLayoutEffect(()=>{
    const update=()=>{const r=ref.current?.getBoundingClientRect();if(r)setPos(floatingPosition({x,y,width:r.width,height:r.height,viewportWidth:window.innerWidth,viewportHeight:window.innerHeight,gap}));};
    update();window.addEventListener('resize',update);
    if(onDismiss)window.addEventListener('scroll',onDismiss,true);
    return()=>{window.removeEventListener('resize',update);if(onDismiss)window.removeEventListener('scroll',onDismiss,true);};
  },[x,y,children,onDismiss,gap]);
  return createPortal(<div className="mpui mp-floating-root"><div ref={ref} role="tooltip" className={className} style={{left:pos?.left??0,top:pos?.top??0,visibility:pos?'visible':'hidden',maxWidth:className==='a-tip'?'min(260px, calc(100vw - 16px))':'calc(100vw - 16px)',maxHeight:'calc(100vh - 16px)',overflow:'auto',boxSizing:'border-box'}}>{children}</div></div>,document.body);
}
