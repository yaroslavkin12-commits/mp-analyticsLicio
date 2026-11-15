// Координаты всплывающего окна в пределах видимой области.
export function floatingPosition({x,y,width,height,viewportWidth,viewportHeight,gap=14,padding=8}) {
  const w=Math.min(width,Math.max(0,viewportWidth-padding*2)),h=Math.min(height,Math.max(0,viewportHeight-padding*2));
  let left=x+gap,top=y+gap;
  if(left+w>viewportWidth-padding)left=x-w-gap;
  if(top+h>viewportHeight-padding)top=y-h-gap;
  return {left:Math.max(padding,Math.min(left,viewportWidth-w-padding)),top:Math.max(padding,Math.min(top,viewportHeight-h-padding))};
}
