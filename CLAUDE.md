# Contexto del Proyecto: Cartera de Préstamos

## Descripción General

App de escritorio para gestión de préstamos personales.

- **Stack:** Electron + Express (127.0.0.1:3420) + better-sqlite3 + React 18 UMD (sin JSX, sin build step)
- **UI:** Un solo archivo `public/index.html` usando `React.createElement` directamente
- **Ventana:** 460x860, estilo móvil, tema oscuro

## Ubicación del Proyecto

```
C:\Users\juanp\Documents\Proyecto_PTM
```

## Archivos Principales

| Archivo | Descripción |
|---|---|
| `main.js` | Ventana Electron + IPC handlers para ruta de BD |
| `server.js` | Express API + SQLite + motor financiero |
| `preload.js` | Expone `electronAPI` al frontend vía contextBridge |
| `public/index.html` | UI completa en React (~1200+ líneas) |
| `package.json` | Dependencias + scripts de build |
| `.github/workflows/build.yml` | GitHub Actions: compila .exe (Windows) y .dmg (Mac) |
| `build/uninstaller.nsh` | Script NSIS para opción de borrar datos al desinstalar |
| `build/icon.ico` / `build/icon.png` | Ícono de la app |

## Base de Datos

Archivo: `cartera.db` (SQLite) — en desarrollo junto al código; instalado en `%APPDATA%\cartera-prestamos\cartera.db`

### Tablas

**loans** — Préstamos con: nombre, cédula, teléfono, moneda (COP/USD), monto, tasa, plazo, modalidad, estado, fechaInicio, diaPago, trmAcordada, montoOrigen, montoCOP

**payments** — Cronograma de cuotas con: prestamoId, cuotaN, fechaPago, cuotaTotal, interesPeriodo, abonoCapital, saldoFinal, estadoPago (Pendiente/Pagado/En Mora), fechaRecaudo, observaciones, montoCOPRecibido, montoUSDRecibido

**config** — Clave-valor (ej: TRM)

## Modalidades de Préstamo

| Modalidad | Descripción |
|---|---|
| `Intereses` | Solo paga intereses mensuales, capital al final. Plazo **∞** (antes se llamaba "Solo Intereses") |
| `Capital + Intereses` | Amortización francesa (PMT). Plazo fijo |
| `Prestamo` | 0% interés, 1 cuota por el capital total. Tasa y plazo bloqueados en formulario |

**Fórmula PMT:** `PMT = pv * r * (1+r)^n / ((1+r)^n - 1)`

## Vistas del Frontend (navegación hamburguesa superior izquierda)

1. **Inicio (Dashboard)** — KPIs, secciones: En Mora, Vence Hoy, Vencen en 3 días, Próximos 7 días, botón Sincronizar datos
2. **Cartera** — Lista de préstamos Activos/Finalizados, cronograma expandible, historial de abonos separado
3. **Deudores** — Perfiles con préstamos expandibles, historial de créditos
4. **Pagos** — Solo pendientes/mora (sin pagados), secciones: En Mora, Vence Hoy, Próximas a Cobrar
5. **Rendimiento** — Portfolio con KPIs globales, tarjetas por préstamo, tabs Activo/Cancelado
6. **Calculadora** — Simulador con soporte COP/USD, cronograma tentativo, botón Confirmar→crea préstamo
7. **Desarrollador** — Sección para cambiar la ubicación de la BD (para sincronizar con iCloud, etc.)

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

### Cálculo de Saldo Real (por modalidad)
```javascript
// Intereses: servidor ya restó abonos de montoCOP
saldo = loan.montoCOP

// Capital + Intereses: restar solo amortización de cuotas regulares pagadas
saldo = loan.montoCOP - capitalAmortizadoEnCuotasPagadas

// Prestamo: igual que Intereses
saldo = loan.montoCOP
```

**⚠️ Regla crítica:** El frontend NO debe restar abonos — el servidor ya los descuenta de `montoCOP` al procesar cada abono.

### USD
- Helpers: `fmtUSD(n)` formatea como `USD $X,XXX.XX`; `copToUsd(cop, trm)` convierte usando `loan.trmAcordada`
- En `PayModal` para USD: campo COP obligatorio + campo USD opcional (`montoUSDRecibido`)
- En `AbonoModal` para USD: campo USD opcional con auto-cálculo COP equivalente
- Los valores USD se muestran en azul debajo de cada valor COP en toda la app

### Cálculo de Ganancia (Rendimiento)
- **COP:** suma de `interesPeriodo` de cuotas pagadas
- **USD:** `montoCOPRecibido - abonoCapital` (utilidad real neta con TRM del momento del pago)

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

## Funcionalidades UI Implementadas

- **Búsqueda global:** Botón lupa en header, busca en deudores/préstamos/pagos simultáneamente
- **Nombres clickeables:** En Dashboard y Pagos, click en nombre → abre perfil del deudor
- **Badge de mora (rojo):** Click → navega a Pagos filtrado en mora
- **Badge de 3 días (amarillo):** Cuotas que vencen en ≤3 días
- **Toast:** 2 segundos, verde para éxito, rojo para eliminación
- **Pago rápido:** Botón ✓ en lista de Pagos (sin modal para COP, con modal para USD)
- **Auto-link deudores:** Al crear préstamo, busca nombre existente (case-insensitive) para consolidar perfil
- **Validación duplicados:** Si mismo nombre + mismo monto activo → confirm() de confirmación
- **Recalcular / Sincronizar:** Botón en Inicio, reconstruye cronogramas sin tocar datos sensibles
- **Sección Desarrollador:** Cambiar ruta de la BD a iCloud, OneDrive, etc.

## Instalador

- **Windows:** NSIS installer (no portable), per-user, permite elegir carpeta
- **Mac:** .dmg
- **Desinstalador:** Pregunta si borrar datos de `%APPDATA%\cartera-prestamos`
- **GitHub repo:** `xJp-P/cartera-prestamos`
- **Distribuir:** GitHub Actions > "Build Instaladores" > Run workflow → descarga artifacts

## Bugs Corregidos (historial)

1. Abono duplicaba cuotas → `buildSchedule` con parámetro `numCuotas` y offset correcto de fechas
2. Modalidad "Préstamo" se auto-pagaba → `abonoCapital: 0` en `buildSchedule`
3. Botón Recalcular no funcionaba → filtro de abonos por `p.id.indexOf('-ab-')` en vez de `interesPeriodo === 0`
4. Editar préstamo borraba abonos → preservar registros con `-ab-` antes de DELETE
5. Input sin foco tras `confirm()` → `window.focus()` post-confirm + `autoFocus` en LoanModal
6. Doble conteo de abonos en saldo → frontend no resta abonos, solo el servidor lo hace
7. Cuota en mora de "Préstamo" mostraba monto original → actualizar `cuotaTotal` al nuevo `montoCOP` (solo para `Prestamo`, no para `Intereses`)
8. Fix de arranque aplicaba a todas las modalidades → restringir a `modalidad = 'Prestamo'` únicamente

## Estado Actual

La app está funcionando en `C:\Users\juanp\Documents\Proyecto_PTM`. El usuario está probando los últimos fixes relacionados con:

- Saldo correcto de Alex (Lynz) — préstamo "Prestamo" en USD con abonos parciales
- La cuota en mora debería mostrar `$2,426,544 / USD $656` (saldo actual tras abonos)
- La BD fue corregida directamente vía SQLite para ese registro

## Próximos Pasos Posibles

El usuario no ha solicitado nuevas tareas explícitas. Está en fase de pruebas del último fix (cuota en mora de "Préstamo" mostrando saldo correcto).