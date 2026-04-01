# Contexto del Proyecto: Cartera de Préstamos

## Descripción General

App de escritorio para gestión de préstamos personales.

- **Stack:** Electron + Express (127.0.0.1:3420) + better-sqlite3 + React 18 UMD (sin JSX, sin build step)
- **UI:** Un solo archivo `public/index.html` usando `React.createElement` directamente
- **Ventana:** 460x860, estilo móvil, tema claro/oscuro (toggle en header)

## Ubicación del Proyecto

```
C:\Users\juanp\Documents\Proyecto_PTM
```

## Archivos Principales

| Archivo | Descripción |
|---|---|
| `main.js` | Ventana Electron + IPC handlers + auto-update (Win: electron-updater, Mac: custom updater) |
| `server.js` | Express API + SQLite + motor financiero |
| `preload.js` | Expone `electronAPI` al frontend vía contextBridge |
| `public/index.html` | UI completa en React (~2500+ líneas) |
| `package.json` | Dependencias + scripts de build |
| `.github/workflows/build.yml` | GitHub Actions: compila .exe (Windows) y .dmg+.zip (Mac) |
| `build/uninstaller.nsh` | Script NSIS para opción de borrar datos al desinstalar |
| `build/icon.ico` / `build/icon.png` | Ícono de la app |

## Base de Datos

Archivo: `cartera.db` (SQLite) — en desarrollo junto al código; instalado en `%APPDATA%\cartera-prestamos\cartera.db` (Win) o `~/Library/Application Support/cartera-prestamos/cartera.db` (Mac)

### Tablas

**loans** — Préstamos con: nombre, cédula, teléfono, moneda (COP/USD), montoOrigen, montoCOP, trmAcordada, tasaMensual, plazoMeses, modalidad, frecuencia (Mensual/Quincenal/Semanal), estado, fechaInicio, diaPago, fechaDevolucion

**payments** — Cronograma de cuotas con: prestamoId, nombreCliente, cuotaN, fechaPago, saldoInicial, interesPeriodo, abonoCapital, cuotaTotal, saldoFinal, estadoPago (Pendiente/Pagado/En Mora), fechaRecaudo, observaciones, montoCOPRecibido, montoUSDRecibido

**config** — Clave-valor (ej: TRM)

**activity_log** — Historial de acciones: id, fecha, tipo, mensaje

## Modalidades de Préstamo

| Modalidad | Descripción |
|---|---|
| `Intereses` | Solo paga intereses, capital al final. Plazo **∞** (indefinido) |
| `Capital + Intereses` | Amortización francesa (PMT). Plazo fijo |
| `Prestamo` | 0% interés, 1 cuota por el capital total. Tasa, plazo y frecuencia bloqueados |

**Fórmula PMT:** `PMT = pv * r * (1+r)^n / ((1+r)^n - 1)`

## Frecuencia de Cobro

| Frecuencia | Conversión de tasa |
|---|---|
| `Mensual` | Tasa mensual tal cual |
| `Quincenal` | Tasa mensual ÷ 2 |
| `Semanal` | Tasa mensual ÷ 4.33 |

La modalidad `Prestamo` no permite seleccionar frecuencia (siempre una sola cuota).

## Vistas del Frontend (navegación hamburguesa superior izquierda)

1. **Inicio (Dashboard)** — KPIs, secciones: En Mora, Vence Hoy, Vencen en 3 días, Próximos 7 días, botón Sincronizar datos
2. **Cartera** — Lista de préstamos Activos/Finalizados, cronograma expandible, historial de abonos separado
3. **Deudores** — Perfiles con préstamos expandibles, cronograma in-app, historial de créditos
4. **Pagos** — Pendientes/mora + toggle para ver pagados, secciones: En Mora, Vence Hoy, Próximas a Cobrar
5. **Rendimiento** — Portfolio con KPIs globales, tarjetas por préstamo, tabs Activo/Cancelado
6. **Calculadora** — Simulador con soporte COP/USD, cronograma tentativo, botón Confirmar→crea préstamo
7. **Historial** — Log de todas las acciones realizadas en la app
8. **Desarrollador** — Cambiar ubicación de la BD, info del sistema, actualizaciones, sincronizar datos

## Lógica de Negocio Clave

### Identificación de Abonos
```javascript
p.id.indexOf('-ab-') !== -1  // abono real
// IDs de abonos: {loanId}-ab-{timestamp}
```

### Auto-mora
Cuotas con `fechaPago < hoy` y `estadoPago = 'Pendiente'` → se marcan `'En Mora'` al arrancar la app.

### Auto-finalización
Cuando todas las cuotas regulares de un préstamo están en `'Pagado'` → `loan.estado = 'Cancelado'` automáticamente.

### Modalidad "Intereses" — Plazo infinito ∞
- Genera cuotas dinámicamente: desde la cuota actual hasta 3 meses adelante
- `autoExtendSoloIntereses()` corre en cada `GET /api/payments`: si quedan menos de 3 cuotas pendientes, genera 3 más
- En UI muestra símbolo `∞` en lugar de número de cuotas
- En cronograma (app y PDF): solo muestra cuotas pagadas y en mora, NO pendientes (para no confundir al deudor)

### buildSchedule(loan, startN, startSaldo, numCuotas)
- 4º parámetro `numCuotas` controla cuántas generar (fix de duplicación de cuotas en abonos)
- Fechas: `getPayDate(fechaInicio, cuotaN, diaPago)` — usa número real de cuota como offset
- Para `Intereses`: usa `cuotasHastaHoy(fechaInicio, startN, 3)`

### Abono a Capital
- Reduce SOLO `montoCOP` del préstamo
- Cuotas en mora permanecen intactas (deuda independiente)
- Para `Prestamo`: actualiza `cuotaTotal` de cuotas en mora al nuevo saldo (`loan.montoCOP`)
- Para `Intereses`/`Capital + Intereses`: NO actualiza cuotas en mora (son intereses, no capital)
- `remaining = indefinido ? 3 : Math.max(0, plazoMeses - regularConsumed)`

### Cálculo de Saldo Real (fórmula unificada)
```javascript
// Fórmula única para TODAS las modalidades:
var originalCOP = loan.moneda === 'USD'
  ? Math.round(loan.montoOrigen * loan.trmAcordada)
  : Math.round(loan.montoOrigen);
var todoCapPagado = allPayments
  .filter(function(p){ return p.estadoPago === 'Pagado'; })
  .reduce(function(s,p){ return s + p.abonoCapital; }, 0);
var saldo = Math.max(0, originalCOP - todoCapPagado);
```

**⚠️ Regla crítica:** Usar siempre `montoOrigen` (nunca cambia) como base. `montoCOP` es poco confiable porque el servidor lo modifica tras abonos pero no siempre persiste correctamente.

### Valor de Liquidación
```javascript
// Capital pendiente + intereses en mora
var intMora = cuotasMora.reduce(function(s,p){ return s + p.interesPeriodo; }, 0);
var liquidacion = saldo + intMora;
```
Se muestra en: cronograma in-app (DebtorModal) y cronograma PDF.

### USD
- Helpers: `fmtUSD(n)` formatea como `USD $X,XXX.XX`; `copToUsd(cop, trm)` convierte usando `loan.trmAcordada`
- En `PayModal` para USD: campo COP obligatorio + campo USD opcional (`montoUSDRecibido`)
- En `AbonoModal` para USD: campo USD opcional con auto-cálculo COP equivalente
- Los valores USD se muestran en azul debajo de cada valor COP en toda la app

### Cálculo de Ganancia (Rendimiento)
- **COP:** suma de `interesPeriodo` de cuotas pagadas
- **USD:** `montoCOPRecibido - abonoCapital` (utilidad real neta con TRM del momento del pago)

## Generación de PDFs

### Recibo de Pago
- Se genera al marcar una cuota como pagada (botón en PayModal)
- Incluye: info del préstamo, detalle del pago, fecha de recaudo
- Usa `window.open()` + `document.write()` + `window.print()`

### Cronograma PDF
- Botón en DebtorModal dentro de cada préstamo
- Incluye: info del préstamo (con tasa %), tabla de cuotas, valor de liquidación
- Para `Intereses`: solo cuotas pagadas/mora + total de intereses pagados
- Para `Capital + Intereses`: todas las cuotas + total capital pagado
- Para `Prestamo`: cuota única
- Abonos a capital se muestran como filas separadas con estilo diferenciado
- **Tema-aware:** se genera con el tema activo (claro u oscuro)

## API Endpoints (server.js)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/loans` | Lista todos los préstamos |
| POST | `/api/loans` | Crear préstamo + generar cronograma |
| PUT | `/api/loans/:id` | Editar préstamo (preserva abonos, regenera cuotas) |
| DELETE | `/api/loans/:id` | Eliminar préstamo y sus pagos |
| GET | `/api/payments` | Todos los pagos + auto-mora + auto-extend |
| PUT | `/api/payments/:id` | Marcar cuota (guarda montoCOPRecibido, montoUSDRecibido) + auto-finalización |
| POST | `/api/loans/:id/abono` | Abono a capital → actualiza montoCOP + regenera cuotas |
| POST | `/api/recalculate` | Recalcula todos los cronogramas activos (preserva abonos) |
| GET | `/api/config` | Leer configuración |
| PUT | `/api/config` | Guardar configuración |
| GET | `/api/activity` | Historial de acciones |

## Funcionalidades UI Implementadas

- **Búsqueda global:** Botón lupa en header, busca en deudores/préstamos/pagos simultáneamente
- **Nombres clickeables:** En Dashboard y Pagos, click en nombre → abre perfil del deudor
- **Badge de mora (rojo):** Click → navega a Pagos filtrado en mora
- **Badge de 3 días (amarillo):** Cuotas que vencen en ≤3 días
- **Toast:** 2 segundos, verde para éxito, rojo para eliminación
- **Pago rápido:** Botón ✓ en lista de Pagos (sin modal para COP, con modal para USD)
- **Abono desde DebtorModal:** Botón "Registrar abono a capital" en perfil del deudor
- **Cronograma in-app:** Tabla expandible en DebtorModal con deuda, cuota, estado, valor de liquidación
- **Cronograma PDF:** Botón para generar PDF del cronograma desde el perfil del deudor
- **Recibo PDF:** Se genera al registrar un pago
- **Auto-link deudores:** Al crear préstamo, busca nombre existente (case-insensitive) para consolidar perfil
- **Validación duplicados:** Si mismo nombre + mismo monto activo → confirm() de confirmación
- **Recalcular / Sincronizar:** Botón en Inicio y Desarrollador, reconstruye cronogramas sin tocar datos sensibles
- **Tema claro/oscuro:** Toggle luna/sol en header, persiste en localStorage, afecta PDFs
- **Sección Desarrollador:** Cambiar ruta de la BD, info del sistema, actualizaciones manuales, sincronizar

## Actualización Automática

- **Windows:** `electron-updater` estándar — descarga e instala automáticamente
- **Mac:** Custom updater en `main.js` — descarga .zip, extrae, aplica `xattr -cr`, reemplaza la app y reinicia
- Motivo del custom updater: Squirrel.Mac requiere firma de código (Apple Developer $99/año)
- Ambas plataformas verifican contra GitHub Releases del repo `xJp-P/cartera-prestamos`

## Instalador

- **Windows:** NSIS installer (no portable), per-user, permite elegir carpeta
- **Mac:** .dmg + .zip (el .zip es para auto-update)
- **Desinstalador (Windows):** Pregunta si borrar datos de `%APPDATA%\cartera-prestamos`
- **Mac primera vez:** Requiere `xattr -cr /Applications/Cartera\ de\ Prestamos.app` por falta de certificado
- **GitHub repo:** `xJp-P/cartera-prestamos`
- **Distribuir:** GitHub Actions > "Build Instaladores" > Run workflow → publica release automáticamente
- **Build Mac:** Requiere Python 3.12 (3.14 rompe `distutils` que necesita `node-gyp`)

## Bugs Corregidos (historial)

1. Abono duplicaba cuotas → `buildSchedule` con parámetro `numCuotas` y offset correcto de fechas
2. Modalidad "Préstamo" se auto-pagaba → `abonoCapital: 0` en `buildSchedule`
3. Botón Recalcular no funcionaba → filtro de abonos por `p.id.indexOf('-ab-')` en vez de `interesPeriodo === 0`
4. Editar préstamo borraba abonos → preservar registros con `-ab-` antes de DELETE
5. Input sin foco tras `confirm()` → `window.focus()` post-confirm + `autoFocus` en LoanModal
6. Doble conteo de abonos en saldo → frontend no resta abonos, solo el servidor lo hace
7. Cuota en mora de "Préstamo" mostraba monto original → actualizar `cuotaTotal` al nuevo `montoCOP` (solo para `Prestamo`)
8. Fix de arranque aplicaba a todas las modalidades → restringir a `modalidad = 'Prestamo'` únicamente
9. Saldo incorrecto tras abonos → fórmula unificada con `montoOrigen - todoCapitalPagado` en todo el frontend
10. Auto-update Mac fallaba por firma de código → custom updater que descarga, extrae y aplica `xattr -cr`
11. Build Mac fallaba con Python 3.14 → workflow fija Python 3.12
12. DB se sobreescribía en segundo PC → verificar si destino ya tiene `cartera.db` antes de copiar
13. EBUSY al mover BD → `pendingDelete` mechanism para borrar en siguiente reinicio

## Estado Actual

La app está funcionando y estable. Versión actual en desarrollo local puede estar adelantada a la última release publicada en GitHub. Las actualizaciones se distribuyen vía GitHub Actions > Build Instaladores.
