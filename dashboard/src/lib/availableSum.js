// Незагруженные дни остаются неизвестными; итог складывается из известных дней.
export function sumAvailable(values) {
  let total=0, known=false;
  for(const value of values) if(Number.isFinite(value)){total+=value;known=true;}
  return known?total:NaN;
}
