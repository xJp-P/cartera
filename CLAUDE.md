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

## Estructura de Carpetas

```
Proyecto_PTM/
├── desktop/              # Capa nativa de Electron
│   ├── main.js           # Ventana + IPC + auto-update (Win: electron-updater, Mac: custom updater)
│   └── preload.js        # Expone `electronAPI` al renderer vía contextBridge
├── backend/              # Capa de datos y lógica de negocio
│   └── server.js         # Express API + SQLite + motor financiero (factory exportada)
├── public/               # Capa de presentación
│   └── index.html        # UI completa en React UMD (~2500+ líneas, sin build step)
├── build/                # Recursos de instalación
│   ├── icon.ico / icon.png
│   └── uninstaller.nsh   # Script NSIS para opción de borrar datos al desinstalar
├── .github/workflows/
│   └── build.yml         # GitHub Actions: compila .exe (Windows) y .dmg+.zip (Mac)
├── package.json          # "main": "desktop/main.js" — "files": desktop, backend, public
├── CLAUDE.md             # Este archivo (contexto para Claude)
├── ESTADO_DEL_PROYECTO.md # Estado actual y pendientes
└── .claudesignore        # Ignorados al escanear el proyecto
```

### Rutas entre módulos

- `desktop/main.js` → carga `../backend/server` como factory del servidor Express
- `desktop/main.js` → carga `preload.js` (misma carpeta) en la ventana
- `backend/server.js` → sirve archivos estáticos desde `../public/`
- En modo dev: `cartera.db` y `prefs.json` viven en la raíz del proyecto (`PROJECT_ROOT`)
- En modo empaquetado: ambos viven en `app.getPath('userData')`

## Base de Datos

Archivo: `cartera.db` (SQLite) — en desarrollo junto al código; instalado en `%APPDATA%\cartera-prestamos\cartera.db` (Win) o `~/Library/Application Support/cartera-prestamos/cartera.db` (Mac)

### Tablas

**loans** — Préstamos:
- Identidad: id, nombre, cedula, telefono
- Monto: moneda (COP/USD), montoOrigen, trmAcordada, montoCOP
- Condiciones: tasaMensual, plazoMeses, modalidad, frecuencia (Mensual/Quincenal/Semanal)
- Fechas: fechaInicio, diaPago, fechaDevolucion (solo Prestamo)
- Estado: estado (Activo/Finalizado/Cancelado), notas
- **v1.8+ extras:**
  - `comprasUSD` (JSON) — desglose de compras de USD a TRMs distintas para promedio ponderado
  - `proximaCuotaExtra` + `proximaCuotaExtraN` — extra del prorrateo por cambio de día de pago, persiste tras /recalculate
  - `cuotaFijaPactada` (v1.8.8+) — cuota fija definida por el usuario en "fijar cuota" del abono o reestructurar; > 0 hace que /recalculate use buildScheduleFixedPMT
  - `capitalPerdido` + `interesesPerdidos` — snapshot al cierre forzoso para reportes
  - `gananciaFija` (v1.10.0+) — solo aplica a modalidad `Pago Unico`; monto en COP de la ganancia pactada con el deudor. `POST/PUT /api/loans` lo fuerza a 0 si la modalidad no es Pago Unico

**payments** — Cronograma de cuotas (regulares + abonos):
- prestamoId, nombreCliente, cuotaN, fechaPago
- saldoInicial, interesPeriodo, abonoCapital, cuotaTotal, saldoFinal
- estadoPago (Pendiente/Pagado/En Mora), fechaRecaudo, observaciones
- montoCOPRecibido, montoUSDRecibido (valores reales cobrados, no teóricos)
- **partialPaid** — acumula pagos parciales; auto-marca Pagado cuando `partialPaid >= cuotaTotal`
- **extraConsolidado** — extra del prorrateo aplicado a una cuota específica
- Abonos a capital se identifican por `id.indexOf('-ab-') !== -1` y tienen `interesPeriodo=0`, `abonoCapital>0`

**config** — Clave-valor (ej: TRM, flags de migración como `mig_v18_rename_cancelado`)

**activity_log** — Historial de acciones: id, fecha, tipo (prestamo/edicion/eliminacion/pago/abono/reestructuracion/cierre), mensaje

## Modalidades de Préstamo

| Modalidad | Descripción |
|---|---|
| `Intereses` | Solo paga intereses, capital al final. Plazo **∞** (indefinido) |
| `Capital + Intereses` | Amortización francesa (PMT). Plazo fijo |
| `Prestamo` | 0% interés, 1 cuota por el capital total. Tasa, plazo y frecuencia bloqueados |
| `Pago Unico` | **v1.10.0**: 1 cuota en fecha exacta + ganancia pactada (por % o monto fijo). Columna `loans.gananciaFija` (REAL, COP). En la única cuota: `interesPeriodo = gananciaFija`, `abonoCapital = capital`, `cuotaTotal = capital + ganancia`. Abonos reducen el capital pero la ganancia se mantiene fija. Espejo de `Prestamo` en `/recalculate` y `PUT /loans/:id` (solo regenera si `regularConsumed === 0`) |

**Fórmula PMT:** `PMT = pv * r * (1+r)^n / ((1+r)^n - 1)`

## Frecuencia de Cobro

| Frecuencia | Conversión de tasa |
|---|---|
| `Mensual` | Tasa mensual tal cual |
| `Quincenal` | Tasa mensual ÷ 2 |
| `Semanal` | Tasa mensual ÷ 4.33 |

La modalidad `Prestamo` no permite seleccionar frecuencia (siempre una sola cuota).

## Vistas del Frontend (navegación hamburguesa superior izquierda)

1. **Inicio (Dashboard)** — Rediseñado en v1.9.1+:
   - 4 KPIs en grid 2x2: Capital Original (histórico), Cobros del Mes, Saldo Pendiente, Ganancias
   - Acciones rápidas (4 botones): Nuevo, Pagos, Deudores, Calculadora
   - Chips compactos: deudores, COP/USD count, mora count
   - Card "Recaudo del mes" con barra de progreso (dorado si >100% por mora recuperada)
   - Grid 2x2 estricto (`.dash-card height:380px`, headers alineados con `.dash-card-header min-height:54px`)
   - 4 cards siempre visibles (Vence Hoy, Próximos 7 días, Mora, Transacciones Recientes) — con empty state si vacías
   - max-width 1180px centrado para no estirarse en monitores grandes
2. **Cartera** — Lista de préstamos Activos/Finalizados, cronograma expandible con columnas Capital + Interés + Deuda corrida + Cuota, historial de abonos separado. En Finalizados/Cancelados muestra resumen; para USD (v1.10.1+) incluye Ganancia por intereses + Ganancia/Pérdida por TRM + Ganancia total (misma lógica que Rendimiento: `montoCOPRecibido − cuotaTotal` para cuotas, `montoCOPRecibido − montoUSDRecibido×trmAcordada` para abonos)
3. **Deudores** — Perfiles con préstamos expandibles, cronograma in-app, historial de créditos. Botonera de acciones en 3 tiers: Cobrar (verde sólido + outline) / Ajustar (gris outline: Reestructurar, Cambiar fecha) / Cronograma (ghost dashed: Ver detalle, PDF)
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

**v1.9.2 fix:** Esta fórmula ahora se usa también en `/api/recalculate` y `PUT /api/loans/:id` (antes usaban `loan.montoCOP` que podía estar stale tras marcar cuotas Pagadas sin abono, generando cuotas Pendientes infladas).

### Opciones de Recálculo en Abono y Reestructurar (v1.9.0+)

Tanto el endpoint `/api/loans/:id/abono` como el nuevo `/api/loans/:id/reestructurar` aceptan `recalcMode`:

- **`mantener`** (default en abono): mantiene `plazoMeses` y baja la cuota mensual. Limpia `cuotaFijaPactada`.
- **`modificarPlazo`**: el usuario define `recalcValor` = nuevo número de cuotas restantes. Genera con `buildSchedule`. Limpia `cuotaFijaPactada`.
- **`fijarCuota`**: el usuario define `recalcValor` = cuota fija deseada en COP (frontend convierte USD→COP). Genera con `buildScheduleFixedPMT` (N-1 cuotas iguales + 1 residual). Persiste `cuotaFijaPactada = recalcValor` para sobrevivir a /recalculate y PUT /loans.

Validación bloqueante: `cuotaFija > saldo * tasaPeriodo` (debe cubrir al menos el interés del primer período).

### Pre-flight de cuotas próximas a mora (v1.9.0+)

Antes de un abono con recálculo o un reestructurar, si hay cuotas Pendientes con `fechaPago - hoy <= 5 días`, aparece `PreflightMoraModal` con 3 opciones:
- **Marcar en Mora primero**: las cuotas se preservan como deuda independiente y NO se absorben en el nuevo cronograma
- **Continuar sin marcar**: las cuotas se absorben en la regeneración
- **Cancelar**: aborta la operación

### Bloqueo de campos sensibles en LoanModal (v1.9.0+)

`hasActivity = pagadas > 0 OR abonos > 0 OR mora > 0`. Si true:
- Campos bloqueados (`disabled` + estilo gris): moneda, montoOrigen, trmAcordada, modalidad, tasaMensual, plazoMeses, frecuencia, fechaInicio, fechaDevolucion, checkbox "compras fraccionadas" + sus inputs
- Banner amarillo arriba avisando
- Defense-in-depth en `submit()`: aunque el `disabled` falle, sobrescribe los campos bloqueados con los valores originales del loan antes de enviar al backend
- Editables: Nombre, Cédula, Teléfono, Notas, Estado

### Atomicidad de endpoints de escritura (v1.9.0+)

`/api/loans/:id/abono` y `/api/loans/:id/reestructurar` son **transaccionales**:
- Fase 1: lectura + validación + cómputo del nuevo cronograma en memoria (SIN escribir)
- Fase 2: todas las escrituras dentro de `db.transaction(() => { ... })()`
- Si falla validación → 4xx, BD intacta. Si falla la transacción → rollback automático.

`/api/recalculate` y `PUT /api/loans/:id` (v1.9.0+) borran solo **Pendientes regulares**, preservando intactas Pagadas + Mora + Abonos.

### Recaudo del mes — flujo de caja estricto (v1.9.2+)

- **ESPERADO** = `Σ cuotaTotal` de cuotas con `fechaPago` en el mes actual (la mora arrastrada NO contamina la meta)
- **RECIBIDO** = (A) cobros del mes (Pagado: `montoCOPRecibido || cuotaTotal`; resto: `partialPaid`) + (B) mora recuperada (cuotas con `fechaPago` de meses anteriores + `estadoPago='Pagado'` + `fechaRecaudo` en mes actual)
- **% > 100%** → barra se capa visualmente al 100% pero el texto muestra el % real; cambia a color dorado con badge "META SUPERADA"

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

## API Endpoints (backend/server.js)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/loans` | Lista todos los préstamos |
| POST | `/api/loans` | Crear préstamo + generar cronograma |
| PUT | `/api/loans/:id` | Editar préstamo. **v1.9.0+:** solo borra Pendientes; preserva Pagadas+Mora+Abonos. Usa saldoReal computado, no `loan.montoCOP` |
| DELETE | `/api/loans/:id` | Eliminar préstamo y sus pagos |
| GET | `/api/payments` | Todos los pagos + auto-mora + auto-extend |
| PUT | `/api/payments/:id` | Marcar cuota (guarda montoCOPRecibido, montoUSDRecibido) + auto-finalización. Reinicia `partialPaid` al cambiar estado |
| POST | `/api/payments/:id/partial` | Pago parcial: acumula en `partialPaid`. Si completa → auto-marca Pagado + auto-finalización del préstamo |
| POST | `/api/loans/:id/abono` | Abono a capital + recalculo de cuotas. **v1.9.0+:** atómico con `db.transaction`. Acepta `recalcMode` (mantener/modificarPlazo/fijarCuota) + `recalcValor`. Persiste `cuotaFijaPactada` cuando aplica |
| POST | `/api/loans/:id/reestructurar` | **v1.9.0+ nuevo:** recalcula cronograma de cuotas FUTURAS sin necesidad de abono. Solo Capital + Intereses. Atómico. Acepta `recalcMode` (modificarPlazo/fijarCuota) + `recalcValor` |
| POST | `/api/loans/:id/force-close` | Cierre forzoso (marca `Cancelado`, snapshot de `capitalPerdido` + `interesesPerdidos`, borra Pendientes/Mora) |
| POST | `/api/loans/:id/cambiar-dia-pago` | Cambiar día de cobro + prorrateo de mora consolidada en la primera cuota. Persiste el extra en `proximaCuotaExtra` para que sobreviva a /recalculate |
| POST | `/api/recalculate` | Recalcula todos los cronogramas activos. **v1.9.0+:** solo borra Pendientes; preserva Pagadas+Mora+Abonos. **v1.9.2 fix:** usa `saldoReal = originalCOP - capPagado` (antes usaba `loan.montoCOP` stale) |
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
- **Pago parcial:** Toggle **Pago completo / Pago parcial** en PayModal. En modo parcial se ingresa el monto y la cuota acumula `partialPaid`. Las filas con parcial muestran tag **PARCIAL**, sub-línea "Abonado $X de $Y" y el monto principal se convierte en el saldo restante.
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
- **Mac:** Custom updater en `desktop/main.js` — descarga .zip, extrae, aplica `xattr -cr`, reemplaza la app y reinicia
- Motivo del custom updater: Squirrel.Mac requiere firma de código (Apple Developer $99/año)
- Ambas plataformas verifican contra GitHub Releases del repo `xJp-P/cartera-prestamos`

### Boot Sequence Protegido (v1.9.2+)

Para evitar que código viejo bugueado toque la BD antes de que el usuario pueda actualizarse, el arranque tiene 4 fases:

```
FASE 1 — Preflight (sin BD, sin servidor)
  prefs.json + resolución de DB_PATH (solo strings)
FASE 2 — Splash inmediato
  Ventana 440×290 frameless con countdown 60s + spinner CSS
FASE 3 — Update check aislado (max 60s)
  Windows: autoUpdater.checkForUpdates()
  Mac: HTTPS GET a GitHub Releases API + compareVersions
  Returns: 'install' | 'skip' | 'timeout'
FASE 4a — Install (BD nunca se toca)
  Descarga + quitAndInstall (Win) / script bash de reemplazo (Mac)
FASE 4b — Arranque normal
  startBackend() (require backend/server.js) + createWindow()
FASE 4-OFFLINE — Timeout sin internet (v1.9.3+)
  Splash cambia a vista con icono ⚠ y dos botones:
  "Continuar" → cae a FASE 4b / "Cerrar app" → app.quit() limpio
```

**Reglas clave:**
- `require('../backend/server')(DB_PATH)` se ejecuta SOLO en `startBackend()`, no en top-level
- `nodeIntegration: true` solo en el splash (contenido 100% local, sin riesgo)
- IPC `'splash-decision'` para los botones de la vista offline
- `setTimeout(checkForUpdates, 3000)` post-arranque eliminado (el check ahora es boot-blocking)
- Banner in-app de actualización opcional sigue funcionando via IPC `'check-for-updates'` (para checkeos manuales post-arranque)

## Instalador

- **Windows:** NSIS installer (no portable), per-user, permite elegir carpeta
- **Mac:** .dmg + .zip (el .zip es para auto-update)
- **Desinstalador (Windows):** Pregunta si borrar datos de `%APPDATA%\cartera-prestamos`
- **Mac primera vez:** Requiere `xattr -cr /Applications/Cartera\ de\ Prestamos.app` por falta de certificado
- **GitHub repo:** `xJp-P/cartera-prestamos`
- **Distribuir:** GitHub Actions > "Build Instaladores" > Run workflow → publica release automáticamente
- **Build Mac:** Requiere Python 3.12 (3.14 rompe `distutils` que necesita `node-gyp`)

## Mantenimiento de documentación post-release (OBLIGATORIO)

**Cada vez que el usuario autoriza un commit + push de una actualización**, además del bump de versión en `package.json` y la entrada en el objeto `CHANGELOGS` de `public/index.html`, se DEBEN actualizar en el mismo commit del release:

- **`ESTADO_DEL_PROYECTO.md`** — actualizar versión actual, último sprint, nuevas features/lógicas implementadas, y el estado de working tree / releases. Es un documento vivo (refrescar el campo "Última revisión").
- **`README.md`** — solo si la actualización agrega o cambia funcionalidades visibles para el usuario final (nuevas modalidades, vistas, capacidades). Reflejarlo en la lista de Funcionalidades y secciones afectadas. Si el cambio es interno (refactor, fix sin impacto en UX), README puede no requerir cambios.

**Regla de consistencia:** tras cada release, `package.json` (versión), `CHANGELOGS`, `ESTADO_DEL_PROYECTO.md` y (si aplica) `README.md` deben quedar coherentes entre sí y con lo realmente implementado. Igual que con el changelog, **no documentar operaciones administrativas internas** (reparaciones manuales de BD, scripts únicos) en README.

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
14. **v1.9.0:** `/api/recalculate` y `PUT /api/loans/:id` sobrescribían cuotas Pagadas + Mora con valores nuevos → ahora solo borran Pendientes regulares
15. **v1.9.0:** `/api/abono` no era atómico — si fallaba la validación de recalcMode tras el DELETE, la BD quedaba corrupta → toda validación + computación ahora ocurre ANTES de la primera escritura, dentro de `db.transaction`
16. **v1.9.0:** race condition en `_doReestructurar`/`_doAbono` mostraba datos viejos en DebtorModal tras reabrir → ahora se `await reload()` antes de `setDebtorModal(fromDeudor)`
17. **v1.9.2:** `/api/recalculate` regeneraba Pendientes inflados (hasta 3x el valor real) porque usaba `loan.montoCOP` stale → fix calcula `saldoReal = originalCOP - capPorAbonos - capPorCuotasPagadas` igual que el resto de endpoints
18. **v1.9.2+:** código viejo bugueado podía tocar la BD antes de que el usuario instalara updates → boot sequence de 4 fases con splash + update check pre-BD

## Estado Actual

La app está funcionando y estable en v1.9.3 (release publicada en GitHub). Las actualizaciones se distribuyen vía GitHub Actions > Build Instaladores y los usuarios reciben auto-update protegido por el nuevo boot sequence.
