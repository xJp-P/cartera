// public/js/componentes/GananciaBimonetaria.js — la ganancia de un credito en dolares, en sus DOS realidades.
//
// REGLA DEL PO (cuentas bimonetarias, 2026-09-13):
//   - "Recibido en USD": los dolares que entraron como ganancia. El cliente paga lo pactado: si
//     pago USD 50 de interes, la ganancia en dolares ES USD 50, y la TRM no la toca.
//   - "Consolidado en COP": esa misma ganancia llevada a pesos, que SI castiga la perdida por TRM
//     (con piso en cero por cuota, ver `gananciaDe`).
//
// Son dos cifras distintas y por eso van LADO A LADO y rotuladas. La version anterior ponia los
// dolares como sub-linea azul debajo de los pesos, y esa posicion se lee como "la conversion de
// la misma cifra": justo lo que no son. Un solo componente para las cinco pantallas que la
// muestran (Rendimiento, perfil del deudor, historial de cerrados y Cartera activo y cerrado),
// para que las cinco se lean igual.

import { h } from '../core/react.js';
import { fmt, fmtUSD } from '../core/format.js';

// Nota bajo la cifra en pesos: dice POR QUE no coincide con los dolares, y solo cuando no coincide.
//   - Prestamo (0%): la cifra en pesos es el EFECTO TRM de caja, con su signo.
//   - piso aplicado: alguna cuota perdio por cambio mas que su interes, y eso NO se resto.
//   - perdida por TRM dentro del interes: la cifra en pesos ya viene neta.
export function notaCOPGanancia(gp, esPrestamo, efectoCOP){
  if (esPrestamo) return efectoCOP < 0 ? 'Sin interes · TRM bajo al cobrar'
                       : efectoCOP > 0 ? 'Sin interes · TRM subio al cobrar' : 'Sin interes · sin variacion TRM';
  if (gp && gp.pisoAplicado) return 'La perdida por TRM solo descuenta hasta los intereses de cada cuota';
  if (gp && gp.cop < gp.interes) return 'Neta de la perdida por TRM';
  return null;
}

export function GananciaBimonetaria(props){
  var usd = Math.round((+props.usd || 0) * 100) / 100;
  var cop = Math.round(+props.cop || 0);
  var tam = props.compacto ? 13 : 15;
  var signo = function(n){ return n < 0 ? '-' : (n > 0 ? '+' : ''); };
  var colorCOP = cop < 0 ? 'var(--red)' : cop > 0 ? 'var(--green)' : 'var(--text2)';
  var celda = function(rotulo, valor, color, nota, derecha){
    return h('div', { style: { minWidth: 0, textAlign: derecha ? 'right' : 'left' } },
      h('div', { style: { fontSize: 9, color: 'var(--text3)', fontWeight: 600, letterSpacing: .4, textTransform: 'uppercase' } }, rotulo),
      h('div', { className: 'mono', style: { fontSize: tam, fontWeight: 600, color: color, whiteSpace: 'nowrap', marginTop: 1 } }, valor),
      nota && h('div', { style: { fontSize: 9, color: 'var(--text3)', marginTop: 2, lineHeight: 1.35 } }, nota));
  };
  return h('div', { style: props.style || null },
    props.titulo && h('div', { style: { fontSize: 11, color: props.colorTitulo || 'var(--text2)', fontWeight: 600, marginBottom: 5 } }, props.titulo),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
      celda('Recibido en USD', signo(usd) + fmtUSD(Math.abs(usd)), 'var(--blue)', props.notaUSD || null, false),
      celda('Consolidado en COP', signo(cop) + fmt(Math.abs(cop)), colorCOP, props.notaCOP || null, true)));
}
