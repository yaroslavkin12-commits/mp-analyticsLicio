import React, { useState, useEffect } from 'react';
import Costs from './Costs';
import Clusters from './Clusters';
import Tax from './Tax';

// «Товары»: себестоимость, склейки и общий налог магазина.
const KEY = 'mp-products-tab';
export default function Products({ cabinet }) {
  const [tab, setTab] = useState(() => { try { return localStorage.getItem(KEY) || 'costs'; } catch (e) { return 'costs'; } });
  useEffect(() => {
    const open = e => { if (e.detail?.page === 'costs' && e.detail?.productTab === 'tax') setTab('tax'); };
    window.addEventListener('mp-open', open);
    return () => window.removeEventListener('mp-open', open);
  }, []);
  const pick = t => { setTab(t); try { localStorage.setItem(KEY, t); } catch (e) { /* ignore */ } };
  const nav = (
    <span className="a-seg">
      {[['costs', 'Себестоимость'], ['clusters', 'Склейки'], ['tax', 'Налог']].map(([k, t]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => pick(k)}>{t}</button>)}
    </span>
  );
  return tab === 'tax' ? <Tax cabinet={cabinet} nav={nav} /> : tab === 'clusters' ? <Clusters cabinet={cabinet} nav={nav} /> : <Costs cabinet={cabinet} nav={nav} />;
}
