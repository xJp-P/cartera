# Estado del Proyecto — Cartera de Préstamos

> Documento vivo. Se actualiza al finalizar cada iteración importante.
> Última revisión: **2026-05-28** — Sprint v1.9.4 → v1.10.2 (release publicada en GitHub).

---

## 1. Versión y estado general

- **Versión local (en `package.json`):** `1.10.2`
- **Última release publicada en GitHub:** `1.10.2` (instaladores Windows + Mac disponibles; el run de "Build Instaladores" sobre `main` incluyó todo lo acumulado desde v1.9.3).
- **Estado:** App funcional y estable en Windows y Mac. Auto-update operativo y protegido por boot sequence.
- **Repositorio:** `xJp-P/cartera-prestamos`
- **Working tree:** limpio, `main` sincronizada con `origin/main`.

---

## 2. Arquitectura actual

Separación en 3 capas:

| Capa | Carpeta | Archivo(s) | Responsabilidad |
|---|---|---|---|
| Nativa / Escritorio | `/desktop` | `main.js`, `preload.js` | Electron: ventana, IPC, boot sequence con splash + update check, generación de PDFs |
| Datos / API | `/backend` | `server.js` | Express + SQLite + motor financiero + lógica de negocio |
| Presentación | `/public` | `index.html` | React 18 UMD (un solo archivo, sin build step) |

`desktop/main.js` arranca el servidor Express de `backend/server.js` **solo después del chequeo de actualizaciones** (v1.9.2+). La ventana principal carga contra `http://127.0.0.1:3420`.

Archivos de apoyo:
- `package.json` — configuración de build (electron-builder) + dependencias.
- `.github/workflows/build.yml` — CI que compila instaladores y publica release en GitHub.
- `build/` — iconos y script NSIS del desinstalador.
- `prefs.json` — preferencias del usuario (ruta alterna de BD, etc.). Se genera en runtime.
- `cartera.db` — base de datos SQLite. En dev vive en raíz del proyecto; en prod en `userData`.

---

## 3. Sprints

### Sprint v1.9.4 → v1.10.2 (más reciente — Pago Único + TRM en Cartera + refinamientos)

**Escape hatch tras error de descarga de update (v1.9.4 → v1.9.5):**
- v1.9.4: si falla la descarga de un update, el splash muestra vista de error con botón "Cerrar app".
- v1.9.5: se agrega "Continuar de todos modos" (escape hatch) junto a "Cerrar app". La invariante estricta de v1.9.4 se relajó a propósito para no bloquear al usuario de su herramienta de trabajo por una falla transitoria de red.
- v1.9.5: el splash muestra el porcentaje numérico junto a la barra durante cualquier descarga (ej: "Descargando v1.9.5... 45%"). Aplica a Win y Mac, in-app y boot.

**Nueva modalidad "Pago Unico" (v1.10.0):**
- 1 cuota en fecha exacta + ganancia pactada (por % sobre el capital o por monto fijo). Indicador en vivo de la equivalencia entre ambas formas.
- Nueva columna `loans.gananciaFija` (REAL, COP). `POST/PUT /api/loans` la fuerza a 0 si la modalidad no es Pago Unico.
- En la única cuota: `interesPeriodo = gananciaFija`, `abonoCapital = capital`, `cuotaTotal = capital + ganancia`.
- Espejo de `Prestamo` en `buildSchedule`, `/recalculate` y `PUT /loans/:id` (solo regenera si `regularConsumed === 0`).
- Abonos a capital reducen el capital pero la ganancia pactada se mantiene fija.
- Soporta COP y USD (con compras fraccionadas a TRMs distintas). Dashboard sin cambios: la modalidad puebla los mismos campos de `payments` que ya leen los KPIs.
- Solo se agrega en LoanModal directo (no en la Calculadora, por decisión del usuario).

**Ganancia/Pérdida por TRM en Cartera (v1.10.1):**
- El resumen del cronograma expandido de préstamos USD terminales (Finalizado y Cancelado) ahora muestra "Ganancia por intereses" + "Ganancia/Pérdida por TRM" + "Ganancia total", reutilizando la lógica de RendimientoView.
- En COP no cambia (sigue "Ganancia obtenida", sin líneas TRM).

**Refinamientos UX (v1.10.2):**
- La card "Pagos en Mora" del Dashboard muestra TODOS los pagos en mora (antes `slice(0,8)`); el `.dash-list-body` hace scroll interno sin romper el tamaño fijo de la card.
- Título dinámico de ganancia/pérdida por TRM unificado en las 3 ubicaciones (Cartera + las 2 secciones del perfil del deudor): dice "Ganancia…" (verde) o "Pérdida…" (rojo) según el signo.

**Bugfix housekeeping (v1.10.0):**
- Al hacer un abono sobre `Prestamo` / `Pago Unico`, los UPDATEs de cuotas En Mora ahora actualizan también `saldoInicial` y `abonoCapital` (no solo `cuotaTotal` y `saldoFinal`), evitando el inflado marginal del KPI "capital recuperado". Mismo fix en `/recalculate`.

### Sprint v1.9.0 → v1.9.3 (el más denso del proyecto)

#### Features nuevas

**Recálculo flexible en abono a capital (v1.9.0):**
- `POST /api/loans/:id/abono` acepta `recalcMode` (`mantener` | `modificarPlazo` | `fijarCuota`) + `recalcValor`
- Frontend (`AbonoModal`) muestra 3 radios con preview en vivo (saldo, nueva cuota, plazo, residual)
- Para USD se ingresa la cuota en dólares y se convierte automáticamente
- Nueva columna `loans.cuotaFijaPactada` para que la opción "Fijar cuota" sobreviva a `/recalculate` y `PUT /loans`

**Reestructurar préstamo (v1.9.0):**
- Endpoint nuevo `POST /api/loans/:id/reestructurar` (solo Capital + Intereses)
- Nuevo componente `RestructureModal` accesible desde el perfil del deudor
- 2 opciones: modificar plazo o fijar valor de cuota
- Cuotas Pagadas y En Mora se preservan intactas; solo regenera cuotas Pendientes

**Pre-flight de cuotas próximas a mora (v1.9.0):**
- Antes de un abono con recálculo o reestructurar, si hay cuotas Pendientes con vencimiento ≤5 días, aparece modal con 3 opciones: Marcar en Mora primero / Continuar / Cancelar
- Componente reutilizable `PreflightMoraModal`
- Aplica en ambos flujos (abono y reestructurar)

**Bloqueo de campos sensibles en LoanModal (v1.9.0):**
- Si el préstamo tiene actividad (pagos, abonos o mora), se bloquean: moneda, montoOrigen, trmAcordada, modalidad, tasaMensual, plazoMeses, frecuencia, fechaInicio, fechaDevolucion, checkbox de compras fraccionadas
- Banner amarillo informativo arriba del modal
- Defense-in-depth: `submit()` sobrescribe los campos bloqueados con valores originales aunque el `disabled` falle
- Solo Nombre, Cédula, Teléfono, Notas y Estado quedan editables

**Dashboard rediseñado (v1.9.1 → v1.9.2):**
- 4 KPI cards modernos en grid 2x2: Capital Original (histórico), Cobros del Mes, Saldo Pendiente, Ganancias
- Acciones rápidas: 4 botones (Nuevo, Pagos, Deudores, Calculadora)
- Stats chips compactos: deudores, COP/USD count, mora count
- Grid 2x2 estricto para las 4 cards de listas (Vence Hoy / Próximos 7 días / Mora / Transacciones Recientes)
- `.dash-card { height: 380px }` + `.dash-card-header { min-height: 54px }` → headers alineados al pixel entre cards
- `.dash-list-body { flex: 1 1 auto; overflow-y: auto }` → scroll interno, scrollbar tenue
- Empty states persistentes con mensajes amigables centrados
- max-width 1180px centrado para no estirarse en monitores grandes

**Recaudo del mes — flujo de caja estricto (v1.9.2):**
- ESPERADO = SOLO cuotas con `fechaPago` en el mes actual (mora arrastrada ya no contamina la meta)
- RECIBIDO = (A) cobros del mes (pagados o parciales) + (B) mora recuperada (cuotas viejas pagadas durante este mes via `fechaRecaudo`)
- Cuando %>100% (por recuperación de cartera vencida): barra cambia a gradiente dorado + badge "META SUPERADA"
- Lista expandida solo muestra cuotas del mes + mora recuperada (no mora histórica pendiente)

**Botonera del perfil del préstamo rediseñada (v1.9.1):**
- 3 tiers jerárquicos con etiquetas de sección uppercase muted:
  - Cobrar: Registrar abono (verde sólido) + Liquidar deuda (verde outline)
  - Ajustar cronograma: Reestructurar + Cambiar fecha (outline neutral)
  - Cronograma: Ver detalle + Descargar PDF (ghost dashed, pareados horizontalmente)
- Paleta unificada en familia verde para acciones de cobro — eliminado el choque visual azul/rojo/gris

**Modal de Novedades con scroll (v1.9.1):**
- `max-height: min(620px, 80vh)` + flex column
- Header (título + contador) y footer (botón "Entendido") fijos
- Lista de items con scroll interno

**Boot sequence protegido (v1.9.2 → v1.9.3):**
- Splash inmediato al abrir la app, antes de cargar el backend o la BD
- Update check vía GitHub Releases API (Mac) o autoUpdater (Windows) con timeout 60s
- Si hay update → descarga + instala + reinicia SIN tocar la BD con código viejo
- Si no hay update O usuario eligió continuar → arranque normal
- **v1.9.3:** countdown visible de 60s arriba del spinner; al timeout se cambia a vista offline con botones "Continuar" / "Cerrar app" (no se auto-decide por el usuario)

#### Bugfixes críticos

1. **`/api/recalculate` y `PUT /api/loans/:id` sobrescribían cuotas Pagadas + Mora** → ahora solo borran Pendientes; Pagadas + Mora + Abonos quedan intactos
2. **`/api/abono` no era atómico** — si la validación de `recalcMode` fallaba tras el DELETE de Pendientes, la BD quedaba corrupta → toda validación + cómputo ahora ocurre ANTES de la primera escritura, dentro de `db.transaction()`
3. **Race condition en `_doReestructurar` / `_doAbono`** — mostraba datos viejos en DebtorModal tras reabrir → ahora se `await reload()` antes de `setDebtorModal(fromDeudor)`
4. **`/api/recalculate` generaba cuotas Pendientes infladas** (hasta 3x el valor real) porque usaba `loan.montoCOP` que no se actualiza al marcar cuotas Pagadas sin abono → ahora calcula `saldoReal = originalCOP - capPorAbonos - capPorCuotasPagadas` igual que el resto de endpoints. Reparados 16 cuotas en BD productiva durante el sprint.
5. **Cronograma de Cartera y Deudores inconsistentes** → unificados con las mismas columnas (Capital + Interés + Deuda corrida + Cuota + Estado)
6. **Modal de Novedades se estiraba demasiado con muchos items** → max-height + scroll interno con header/footer fijos

---

## 4. Funcionalidades principales en producción

### Gestión de préstamos
- Modalidades: `Intereses` (plazo ∞), `Capital + Intereses` (amortización francesa con opción de cuota fija pactada), `Prestamo` (0% interés, una cuota), `Pago Unico` (v1.10.0: una cuota en fecha exacta + ganancia pactada por % o monto fijo, columna `gananciaFija`).
- Frecuencias: Mensual, Quincenal, Semanal (conversión de tasa automática).
- Moneda: COP y USD con TRM acordada por préstamo. Compras fraccionadas con tasa promedio ponderada para USD.
- **Reestructuración:** modificar plazo o fijar cuota sin tener que hacer abono.
- **Abono inteligente:** 3 modos de recálculo + persistencia de cuota fija.

### Vistas (8)
1. **Inicio (Dashboard)** — rediseñado en v1.9.1, modern SaaS layout
2. **Cartera** — Activos/Finalizados + cronograma expandible unificado. En Finalizados/Cancelados USD muestra resumen con Ganancia por intereses + Ganancia/Pérdida por TRM + Ganancia total (v1.10.1)
3. **Deudores** — Perfiles con historial + botonera de 3 tiers
4. **Pagos** — Pendientes/Mora + toggle pagados
5. **Rendimiento** — KPIs globales + tabs Activo/Cancelado
6. **Calculadora** — Simulador → crea préstamo
7. **Historial** — Log de acciones (incluye 'reestructuracion')
8. **Desarrollador** — Ruta de BD, info del sistema, updates, sincronizar

### Lógicas automáticas clave
- **Auto-mora:** cuotas vencidas con `estadoPago='Pendiente'` → `'En Mora'` al arrancar y en cada `GET /api/payments`.
- **Auto-finalización:** todas las cuotas regulares `'Pagado'` → `loan.estado='Finalizado'`. Si tiene `cuotaFijaPactada > 0`, se limpia al finalizar.
- **Auto-extend (Intereses):** si quedan < 3 cuotas pendientes futuras, se generan 3 más automáticamente.
- **Auto-link deudores:** al crear préstamo, consolida por nombre (case-insensitive).
- **Fix cuotas mora Préstamo / Pago Unico:** `cuotaTotal` (+ `saldoInicial` + `abonoCapital`) de mora se ajustan al saldo actual tras abonos. Para Pago Unico la ganancia pactada se conserva (`cuotaTotal = capital restante + gananciaFija`).
- **Ganancia fija en Pago Unico:** los abonos reducen el capital pero `gananciaFija` no cambia; el deudor termina pagando lo acordado.
- **Persistencia cuota fija pactada:** sobrevive a `/recalculate` y `PUT /loans`.
- **Persistencia prorrateo:** `proximaCuotaExtra` + `proximaCuotaExtraN` sobreviven a `/recalculate`.

### PDFs
- **Recibo de pago:** al marcar cuota como pagada.
- **Cronograma:** desde DebtorModal. Tema-aware (claro/oscuro).

### Auto-update y arranque protegido
- **Windows:** `electron-updater` estándar (boot-check + auto-install si hay update).
- **Mac:** Custom updater + GitHub Releases API.
- **Boot sequence (v1.9.2+):** 4 fases que blindan la BD durante el update check.
- **Splash con countdown (v1.9.3):** countdown 60s visible + vista offline con decisión del usuario si no hay internet.

---

## 5. Tareas pendientes / ideas en backlog

### Infraestructura
- [ ] **Optimizar `extraResources` en `package.json`:** actualmente duplica archivos. Se puede limpiar para no enviar `desktop/` + `backend/` + `public/` dos veces (una vez en asar, otra suelta).
- [ ] **Dividir `public/index.html`:** con ~3500+ líneas, empieza a ser costoso en tokens. Posibles paths:
  - Extraer `styles.css` a archivo aparte.
  - Extraer componentes grandes (DebtorModal, LoanModal, PayModal, AbonoModal, RestructureModal, Dashboard) a JS separados y cargarlos con `<script>` (sin build step).
  - Alternativa más ambiciosa: introducir esbuild/Vite y migrar a JSX.
- [ ] **Separar rutas del backend en archivos temáticos:** hoy todo está dentro del factory `createApp()`. Podría separarse en `backend/routes/loans.js`, `backend/routes/payments.js`, etc., y mantener `backend/db.js` con la inicialización del schema.

### UX / Funcional
- [ ] **Notificaciones de vencimientos:** hoy solo se ven al abrir la app. Podría agregarse notification system nativo (Electron `Notification` API).
- [ ] **Backup automático de la BD:** actualmente el usuario debe respaldar manualmente. Se podría programar un snapshot diario a una carpeta configurable.
- [ ] **Exportar reporte financiero:** un PDF mensual con recaudo, mora y proyección.
- [ ] **Versión móvil:** la base Electron no corre en iOS, requeriría migración a Capacitor o acceso al backend local vía Safari en LAN.

### Técnico
- [ ] **Migrar auto-extend a un cron en el proceso Electron:** hoy se dispara en cada `GET /api/payments`. Funciona bien pero ensucia la lectura.
- [ ] **Firma de código para Mac:** si se llega a pagar Apple Developer ($99/año), reemplazar el custom updater por Squirrel.Mac para actualizaciones silenciosas.

---

## 6. Bugs conocidos

Ninguno abierto en este momento. Los sprints v1.9.0 → v1.10.2 cerraron todos los bugs críticos detectados. Historial completo está en `CLAUDE.md` sección "Bugs Corregidos".

---

## 7. Notas para futuras sesiones

### Convenciones de trabajo (importante)

1. **Modo Auditor antes de ejecutar:** para tareas no triviales, generar plan estructurado con `AskUserQuestion` y esperar aprobación del usuario antes de tocar código.
2. **Atomicidad de endpoints:** cualquier endpoint que modifique BD debe validar + computar TODO antes de la primera escritura. Si algo falla, devolver 4xx sin tocar BD. Usar `db.transaction()` de better-sqlite3 para mutaciones múltiples.
3. **Defense-in-depth:** validaciones críticas en frontend Y backend.
4. **Verificación con Python sqlite3:** `better-sqlite3` está compilado para Electron, NO funciona en Node standalone. Para inspeccionar BD del usuario usar Python con `sqlite3` builtin.
5. **Backups antes de tocar BD productiva:** cualquier script Python que escriba en `cartera.db` real debe hacer `shutil.copy()` con timestamp ANTES de cualquier cambio.
6. **Sintaxis siempre validada:** `node --check backend/server.js` para backend, extraer scripts del HTML y validar con `new Function(code)` para frontend.
7. **Sin build step:** UI vive en `public/index.html` con React UMD + `React.createElement` directo. Estilos inline con variables CSS. NO usar Tailwind ni clases utilitarias.
8. **Commits:** HEREDOC + firma Co-Authored-By + título `vX.Y.Z: descripción` o `Fix: descripción`. Bumpeo de versión va en `package.json` + entrada nueva en el objeto `CHANGELOGS` de `public/index.html`.
9. **Changelog del usuario final:** NO incluir operaciones administrativas internas (reparaciones manuales de BD productiva, scripts de migración únicos). Solo cambios que aplican al usuario general.
10. **Push solo cuando el usuario lo pida explícitamente.** El workflow de Build Instaladores en GitHub Actions lo dispara el usuario manualmente.
11. **Mantenimiento de docs post-release (OBLIGATORIO):** tras cada commit + push de una actualización autorizada, actualizar `ESTADO_DEL_PROYECTO.md` (siempre) y `README.md` (si hay cambios de funcionalidad visible) en el mismo commit del release. Mantener coherencia entre `package.json`, `CHANGELOGS`, este documento y el README. Detalle en `CLAUDE.md` → "Mantenimiento de documentación post-release".

### Cosas que NO se renegocian (decisiones de arquitectura ya tomadas)

- **Boot sequence de 4 fases** (FASE 1 prefs → FASE 2 splash → FASE 3 update check con countdown → FASE 4a install / 4b normal / 4-OFFLINE decision modal).
- **Recaudo del mes** = cuotas del mes + mora recuperada (no mora histórica pendiente).
- **`/recalculate`** computa `saldoReal = originalCOP − capitalPagado` (no usa `loan.montoCOP`).
- **`hasActivity`** para bloqueo de campos = cuotas pagadas > 0 OR abonos > 0 OR cuotas mora > 0.
- **Dashboard** grid 2x2 estricto con `.dash-card { height: 380px }` y `.dash-card-header { min-height: 54px }`.
- **Fórmula de saldo:** `montoOrigen - todoCapPagado` (NO `montoCOP`, es poco confiable).
- **Separación abonos vs. cuotas regulares:** filtro `id.indexOf('-ab-')` SIEMPRE.

### Optimización de contexto

- El código está estructurado para bajo consumo de tokens: `/backend` y `/desktop` son pequeños y autocontenidos; la mayor parte del contexto pesado vive en `public/index.html`.
- `.claudesignore` excluye `node_modules`, `dist`, `.git`, `build`, `.github`, DB, y archivos binarios.
- Memoria persistente en `~/.claude/projects/C--Users-juanp-Documents-Proyecto-PTM/memory/`.

### Recordatorios operativos

- **BD productiva del usuario:** `C:\Users\juanp\Desktop\bd_App_PTM_Backup\cartera.db` (NO la del repo).
- **Distribución:** el usuario corre manualmente "Build Instaladores" en GitHub Actions tras cada push.
- **Build Mac requiere Python 3.12** (3.14 rompe `distutils` que necesita `node-gyp`).
</content>
</invoke>