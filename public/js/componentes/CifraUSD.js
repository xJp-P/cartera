// public/js/componentes/CifraUSD.js — la cifra en dolares de la INTERFAZ (3.7.0).
//
// Decision del PO sobre un prototipo con tres alternativas (opcion A, "Tinta"): el dolar que
// acompana a una cifra en pesos ya no va en azul. El azul de la app significa otras cosas (abono,
// pago parcial, capital, credito abierto, enlaces), y pintado tambien en cada sub-linea en dolares
// era lo mas llamativo de cada tarjeta. Ahora la cifra va en TINTA SECUNDARIA (`.dp-usd`, gris) y
// su codigo "US$" en terciaria (`.usd-c`): se distingue por jerarquia y por su lugar, siempre bajo
// o junto a los pesos.
//
// Solo cambia la PRESENTACION: el importe sigue saliendo de `fmtUSD` / `copToUsd` (format.js), y
// los PDF no pasan por aqui (tienen su propia doctrina: un credito en dolares se imprime solo en
// dolares).

import { h } from '../core/react.js';

// "USD $1,234.56", con lo que lleve delante ("incluye ", "+") o detras (" en dolares").
var USD_PIEZAS_RE = /^([\s\S]*?)([+\-]?)USD \$(-?[\d,]+\.\d{2})([\s\S]*)$/;

// Parte el texto de un importe en dolares en sus piezas: el codigo "US$" en su propio <span>
// (tinta terciaria, `.usd-c`) y el numero tal cual. Un texto que no es un importe en dolares se
// devuelve sin tocar, para que un dato inesperado nunca desaparezca de la pantalla.
export function usdPiezas(texto){
  var s = texto == null ? '' : String(texto);
  var m = USD_PIEZAS_RE.exec(s);
  if (!m) return s;
  return [m[1] + m[2], h('span', { key: 'c', className: 'usd-c' }, 'US$'), m[3] + m[4]];
}

// La sub-linea en dolares bajo (o junto a) una cifra en pesos. `estilo` conserva lo que cada
// pantalla ya tenia (tamano, alineacion); el color lo pone SIEMPRE la clase.
export function usdLinea(texto, estilo, tag){
  return h(tag || 'div', { className: 'dp-usd mono', style: estilo || null }, usdPiezas(texto));
}
