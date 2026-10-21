import React, { useState } from 'react';
import Costs from './Costs';
import Clusters from './Clusters';

// «Товары»: подвкладки «Себестоимость» и «Склейки».
const KEY = 'mp-products-tab';
export default function Products({ cabinet }) {
  const [tab, setTab] = useState(() => { try { return localStorage.getItem(KEY) || 'costs'; } catch (e) { return 'costs'; } });
  const pick = t => { setTab(t); try { localStorage.setItem(KEY, t); } catch (e) { /* ignore */ } };
  const nav = (
    <span className="a-seg">
      {[['costs', 'Себестоимость'], ['clusters', 'Склейки']].map(([k, t]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => pick(k)}>{t}</button>)}
    </span>
  );
  return tab === 'clusters' ? <Clusters cabinet={cabinet} nav={nav} /> : <Costs cabinet={cabinet} nav={nav} />;
}
