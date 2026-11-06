# Cartera

App de escritorio para gestionar tu cartera de credito personal en ambos sentidos: lo que te deben (prestamos que otorgas) y lo que tu debes (tus propias deudas). Registra prestamos, cobra cuotas, genera recibos, lleva el seguimiento de tus deudores y controla tus obligaciones, todo en un solo lugar.

## Funcionalidades

- **Prestamos en COP y USD** con conversion automatica via TRM (incluye compras fraccionadas a distintas tasas); al crear puedes asignar el prestamo a un **cliente existente** (buscador por nombre) o registrar uno nuevo
- **5 modalidades:** Intereses (plazo indefinido), Capital + Intereses (amortizacion francesa), Prestamo (0% interes), Pago Unico (una cuota en fecha exacta + ganancia pactada por % o monto fijo), **Interes Diario** (credito abierto: el interes se genera cada dia sobre el capital vivo, sin cuotas ni plazo; el cliente paga intereses o abona a capital cuando quiera y cada movimiento se registra como un *corte*. Admite fecha de inicio en el pasado: al crearlo ya trae los dias transcurridos)
- **Frecuencia de cobro:** semanal, quincenal o mensual
- **Fecha del primer pago y dias de gracia:** al crear un prestamo de Intereses o Capital + Intereses, con cobro **mensual, quincenal o semanal**, eliges cuando se paga la primera cuota. Si cae **mas lejos** que un periodo normal, la opcion preseleccionada es **perdonar los dias de mas** (dias de gracia): la primera cuota cobra una semana, una quincena o un mes normal, y una barra muestra desde que dia corre el interes; si prefieres, cobras **todos los dias**. Si cae **antes**, eliges entre cobrar solo esos dias (por defecto) o el periodo completo. Siempre ves las dos cifras en vivo y no hay limite de fecha. El interes de los dias se mide con el periodo de la frecuencia: 7 dias de un credito semanal valen exactamente su cuota semanal. Al liquidar durante un primer periodo cobrado por dias eliges **cuantos dias** de interes cobrar; dentro de los dias de gracia no se cobra interes por adelantado
- **Registrar cobro (imputacion en cascada):** escribes cuanto dinero recibiste y la app lo reparte sola en el orden correcto — primero los intereses de las cuotas vencidas, luego el capital de esas cuotas y al final lo que sobre como abono extraordinario a capital. Antes habia que decidir a mano por cual puerta entraba el dinero, y registrarlo como abono mandaba el 100% a capital dejando sin cobrar los intereses ya vencidos. El modal muestra el desglose completo antes de confirmar y una **previsualizacion del cronograma** tal como quedara despues del cobro. Cada cobro queda como movimientos independientes, reversibles por separado desde el Historial
- **Abonos a capital** con recalculo automatico del cronograma (mantener plazo, modificar plazo o fijar cuota). El modal distingue el capital **abonable** del que esta retenido en cuotas en mora y topa el abono en la cifra correcta; si el dinero recibido alcanza tambien para esa mora, te ofrece pasar de un clic a **Liquidar deuda** (que cobra capital + intereses atrasados de una vez). En prestamos en USD pide **doble entrada**: los dolares del abono, que definen el capital a descontar a la TRM pactada, y los COP realmente recibidos — con la TRM implicita y el efecto cambiario calculados en vivo
- **Pagos en dolares valuados a la tasa pactada:** cuando registras un pago de un prestamo en USD, el campo de dolares es obligatorio y es el que manda: si el cliente entrega USD 120 de una cuota de USD 250, la deuda baja USD 120 aunque ese dia la tasa rinda menos pesos. Los pesos que entraron se guardan aparte como caja real, y el modal te muestra en vivo la tasa implicita del pago y cuanto ganaste o perdiste por el cambio antes de confirmar
- **Pagos parciales que cuentan desde el primer peso:** si un cliente abona una parte de la cuota, el dinero se refleja de inmediato en el capital recuperado, los intereses cobrados y el saldo — en la app **y en todos los PDF**, que muestran siempre la misma cifra que la pantalla. Cada pago se reparte primero al interes del periodo y el sobrante baja el capital (orden de imputacion del Codigo Civil), y ese reparto se ve movimiento por movimiento en el flujo de caja del deudor, con una columna **Efecto TRM** en los prestamos en dolares para saber cuanto se gano o se perdio por el cambio en cada cobro
- **Reestructuracion** de cronograma sin necesidad de abono (Capital + Intereses)
- **Recibos PDF** generados al registrar un pago, con mensaje segun la puntualidad (agradecimiento por pago puntual/anticipado o aviso con los dias de retraso)
- **Recibo de Cobro (Factura) en PDF** desde la vista Cobros: por cada cuota pendiente generas un recibo formal con un mensaje que cambia segun el estado de la cuota (aviso de mora con los dias de atraso, recordatorio si vence hoy, o aviso de proximo vencimiento con los dias que faltan). Muestra el total a pagar, el desglose de la cuota y el saldo, prioriza el dolar en prestamos en USD, lleva un codigo de factura (FC) y un bloque "Como pagar" configurable en Desarrollador. Se descarga como "FC [Cliente] - C[cuota].pdf"
- **Recibo de Abono a Capital en PDF** al registrar un abono (desde el panel del deudor o al liquidar), con un check para generarlo o no: confirma el monto recibido y el nuevo saldo, incluye el cronograma de pagos actualizado con el impacto del abono (cuanto bajo la cuota, cuantas cuotas menos quedan o la nueva cuota fija, segun como recalcules) y te dice cuanto costaria liquidar la deuda ese mismo dia. Si el abono salda el prestamo, el documento se convierte en un Paz y Salvo
- **Condonar intereses:** para el acuerdo de "devuelveme el capital y te perdono los intereses". Desde el panel del deudor eliges que cuotas vencidas perdonar (o todas), y el interes deja de cobrarse mientras el capital queda intacto. **No registra ningun pago**, asi que no aparece en los cobros del mes ni infla las ganancias; despues cobras el capital normalmente y el credito se cierra como Finalizado. En los creditos de interes diario condona el interes acumulado a la fecha. Queda en el historial y se puede deshacer
- **Recibo de pago del cobro en cascada en PDF**, con un check para generarlo o no: un unico recibo por todo el dinero que recibiste, aunque por dentro se haya registrado como varios movimientos. Arriba, una sola cifra con lo que entro, de quien y cuando; despues, una frase por movimiento que dice a que se fue el dinero (las cuotas vencidas saldadas, el abono a capital, el interes adelantado) y la barra de la cuota que quedo a medias; luego **lo que sigue**: cuanto le falta para ponerse al dia, su proxima cuota y la suma exacta que lo deja al dia; el avance del credito en una barra de cuotas con lo que falta por pagar y cuanto de eso es capital; y una tabla corta de sus cuotas. En prestamos en dolares va expresado solo en dolares. Si el cobro alcanza a cancelar el credito, sale como Paz y Salvo. Cabe en una hoja carta. Lleva codigo (RC) y se descarga como "RC [Cliente] - $[monto].pdf". Si algun movimiento fallara, no se emite: un comprobante por menos dinero del que entrego el cliente seria peor que ninguno
- **Recibo de cobro general en PDF**: un aviso de cobro con **toda la deuda vencida de un cliente** en un solo papel. Arriba, lo que debe para ponerse al dia (cuantas cuotas y desde cuando); el detalle de lo vencido cuota por cuota con los dias de mora; tres opciones de pago con su monto exacto (ponerse al dia, al dia mas la proxima cuota, o liquidar con su fecha de validez); el estado de cada credito; y el bloque "Como pagar". Si el cliente tiene varios creditos, el total consolidado va arriba y el detalle de cada credito debajo (pesos y dolares por separado). Aclara que no certifica ningun pago. Se genera desde la fila del credito con varias cuotas vencidas en Cobros y desde la cabecera del panel del deudor; se descarga como "CG [Cliente] - [fecha].pdf"
- **Estado de Liquidacion en PDF** desde el modal de Liquidar deuda, antes de confirmar el cierre: desglosa capital pendiente, intereses atrasados —incluidos los que quedaron dentro de la cuota siguiente si alguna vez cambiaste el dia de cobro— (o el interes acumulado en los creditos abiertos), los abonos parciales ya recibidos y el periodo de interes adicional si lo cobras —un mes, o una semana o una quincena en los creditos semanales y quincenales; si el periodo en curso es irregular, los **dias** de interes que elijas; y nada mientras el credito este en sus dias de gracia—, hasta el total exacto a pagar ese dia. Incluye el historial del credito a la fecha —cuotas pagadas con su fecha real de recaudo y abonos a capital— para que el deudor vea el respaldo de cada peso, y lleva fecha de validez visible porque un valor de liquidacion caduca. Si marcas o desmarcas el mes adicional, el documento se recalcula solo. Se descarga como "Liquidacion [Cliente] - [fecha].pdf"
- **Cronograma PDF** con valor de liquidacion desde el panel de cada deudor, con el desglose de cuanto de cada cuota es interes y cuanto abono a capital. Antes de descargarlo decides si ese valor de liquidacion incluye el **interes del periodo en curso** —del mes, de la semana o de la quincena, segun la frecuencia— (la misma casilla de Liquidar deuda), ves en pantalla la cifra que se imprimira y, si lo incluye, el PDF indica hasta que fecha es valida. En los creditos sin interes el PDF sale directo
- **Cronogramas unificados:** todas las tablas de cuotas (en la app y en los PDF) usan las mismas columnas y los mismos nombres — Vence, Interes, Abono a capital, Valor cuota, Saldo y Estado — y los abonos a capital aparecen intercalados en la fecha en que se hicieron, para que puedas comparar cualquier documento con otro sin traducir terminos
- **Reporte de Prestamos Activos en PDF** (desde Desarrollador): mapa de riesgo con los prestamos en mora primero (ordenados por dinero vencido) y luego los al dia (por saldo pendiente), la cuota actual de cada deudor con su valor (en dolares, los prestamos en USD), las cuotas atrasadas detalladas y el capital total en la calle (con prestamos en las dos monedas, el total vencido y el capital en la calle muestran los pesos y los dolares por separado, "$ X + USD Y", sin convertirlos ni sumarlos entre si)
- **Resumen** que aprovecha todo el ancho de la pantalla: una frase que resume el dia; cinco cifras clave (capital en la calle, cobrado en el mes con su curva diaria, ganancia del mes y de los ultimos 12 meses, mora y **posicion neta**: lo que te deben menos lo que debes en Mis Deudas); una **agenda de cobro** de 7, 14 o 30 dias con lo vencido por deudor; y, lado a lado, un **radar** de cada prestamo activo ordenado por riesgo (con filtros), la **meta del mes** y los ultimos movimientos de caja. Al final, un enlace al analisis del negocio, que vive en Rendimiento. En el telefono la agenda se muestra como lista
- **Cobros:** la bandeja del dia, con todo lo que hay que cobrar ordenado por urgencia en cinco tramos (vencido, hoy, proximos 7 dias, este mes y mas adelante, este ultimo plegado). Lo vencido se agrupa por credito (plegado en una sola linea con cuantas cuotas, cuanto suman y los dias de mora de la mas vieja) y se cobra de una vez con el cobro en cascada; cada cuota tiene su boton **Pago** y su factura en PDF a un clic. La vista **Cobrado** muestra toda la caja del mes, dia por dia, separada en intereses, capital y efecto TRM
- **Cartera:** cada deudor con sus prestamos activos, ordenados por lo que necesita atencion primero, con filtros (en mora, cobran esta semana, en dolares, sin prestamos activos), orden y busqueda por nombre o telefono. La pestana **recuerda donde la dejaste**: al volver siguen elegidos el filtro, el orden y la persona (con su prestamo) que tenias abierta, **tambien despues de cerrar y volver a abrir la aplicacion**
- **Cambiar el dia de pago** de un prestamo mensual: la primera cuota nueva cobra solo los dias que van desde la ultima cuota ya facturada hasta la nueva fecha (nunca se adelanta un cobro), y las cuotas vencidas se quedan como estan, para cobrarlas aparte. Antes de confirmar ves el desglose de esa primera cuota
- **Panel del deudor**, al lado de la lista en Cobros y en Cartera, sin taparla: sus prestamos como pestanas (los cerrados en su historial), las acciones a la vista (registrar cobro, liquidar, cronograma PDF y, en un menu, reestructurar, cambiar el dia de pago, condonar, editar, cerrar o eliminar), las cifras del credito, el cronograma, lo recaudado, la proyeccion de ganancia y el flujo de caja. Tocar un nombre en el Resumen o en la busqueda lo abre directamente
- **Mis Deudas (lo que tu debes):** modulo de cuenta rotativa de doble via para llevar el control de tus propias deudas. Cada deuda se ve como una **cuenta corriente**: el saldo como cifra principal y, en la misma tarjeta y sin abrir ventanas aparte, **todos los movimientos** — el monto inicial y cada cargo o abono posterior, con el saldo que dejo cada uno. La cuenta cuadra a la vista (**Cargado − Abonado = Saldo**), registras que la deuda crecio con el boton **+ Cargo** (que ademas reactiva una deuda ya pagada) y abonas con el boton verde. Al abrir un acreedor, cada prestamo aparece **guardado**: le das clic al que quieras y solo ese muestra su detalle, con una animacion suave. Los acreedores se agrupan en Activos e Inactivos
- **Rendimiento:** cuatro cifras (ganancia obtenida con la de los ultimos 12 meses, **rentabilidad de la cartera**, capital colocado con lo recuperado y saldo en la calle) y una **tabla de prestamos** que se filtra (activos, finalizados, en dolares, con perdida) y se ordena por cualquier columna: capital, recuperado, ganancia, **rentabilidad mensual** y **rentabilidad acumulada** en dos columnas lado a lado (la acumulada es la ganancia obtenida sobre el capital prestado; la mensual, esa misma cifra dividida por los meses que lleva el prestamo, para comparar uno viejo con uno nuevo; en dolares, las dos medidas en dolares), saldo y estado. Un toque en un prestamo lo abre en Cartera. Debajo, el **analisis del negocio**: el flujo de caja de 12 meses en intereses y capital con 3 meses proyectados, y donde esta tu capital por deudor, modalidad o moneda. La ganancia real por prestamo incluye el interes cobrado en pagos parciales y abonos. En los creditos en dolares se muestra en sus dos monedas, lado a lado: **recibido en USD** (los dolares de interes que entraron, intactos) y **consolidado en COP** (esa ganancia en pesos, que descuenta la perdida por TRM de los intereses de cada cuota sin quedar en negativo). Es la misma cifra que muestran el Resumen y el panel del deudor
- **Calculadora** para simular prestamos antes de crearlos, con calculo automatico de la tasa de cambio desde el "Total pagado en COP"
- **Historial de acciones** (log de todo lo que hiciste), **agrupado por dia**, con buscador que no distingue tildes y filtros por **periodo** (hoy, 7 dias, 30 dias, este mes o un rango de fechas) y por **tipo** (cobros, prestamos, Mis Deudas, deshechos); si una accion nombra a un deudor, se abre en Cartera de un toque. Tiene **boton Deshacer**: revierte un pago, un abono, una liquidacion, una reestructuracion, un cierre forzoso, un cambio de fecha de pago o cualquier movimiento de Mis Deudas, y la app restaura el estado **exacto** que tenia antes (cuotas, saldo, fechas y recibos internos). Tres candados lo protegen: solo se puede deshacer la **ultima** operacion de cada prestamo o deuda (las anteriores muestran el boton apagado indicando cual va primero); antes de revertir aparece una **confirmacion** con el detalle, que **avisa si la operacion tiene mas de 24 horas** y, cuando movio dinero, **advierte que el cliente probablemente ya tiene un recibo PDF** con esa informacion; y el historial **nunca se borra** — la operacion queda marcada como revertida y se registra que la deshiciste. Se conservan las ultimas 200 operaciones (o 90 dias) como puntos de retorno
- **Tema claro/oscuro** (PDFs se generan con el tema activo)
- **Buscador que no distingue tildes:** en Cartera, en Cobros y en la busqueda general, "jose", "José" y "JOSÉ" encuentran a la misma persona. La busqueda general tambien reconoce los **codigos de factura (FC-...)**, escritos con o sin tilde: encuentra la cuota aunque ya este pagada y lleva directo a su prestamo
- **Creditos en dolares, en dolares:** los documentos PDF de un credito en USD (cronograma, facturas, recibos, propuestas, liquidaciones, estado de cuenta) muestran **solo dolares**, sin equivalencias en pesos ni la TRM: es la moneda que el cliente paga y entiende. En la app, la cifra en dolares que acompana a los pesos va en gris, con el codigo "US$" mas tenue, para no competir con el resto de la pantalla
- **Ortografia completa en toda la aplicacion:** ventanas, avisos, mensajes de error, historial y documentos; la modalidad se muestra con su nombre completo (Solo intereses, Prestamo sin interes, Pago unico, Interes diario)
- **Documentos PDF con el mismo formato:** todos usan hoja carta con el mismo margen en **cada** hoja (la segunda hoja de un documento largo ya no arranca pegada al borde, y en tema oscuro el fondo llega hasta el borde), repiten los titulos de una tabla cuando sigue en la hoja siguiente y se imprimen con su ortografia completa (tildes y eñes en todos los rotulos)
- **Actualizaciones automaticas** desde GitHub Releases (Windows y Mac), con arranque protegido que blinda la base de datos durante el chequeo de updates
- **Sincronizacion** via iCloud Drive, OneDrive, etc.

## Como instalar en Mac

Descarga el instalador desde [Releases](https://github.com/xJp-P/cartera/releases):

- **Windows:** `Instalador-Windows-X.X.X.exe`
- **Mac:** `Instalador-Mac-X.X.X.dmg`

La app se actualiza automaticamente cuando hay una nueva version disponible.

### Nota para usuarios de Mac

Al abrir la app por primera vez, macOS puede mostrar un mensaje diciendo que la app **"esta danada y no puede abrirse"**. Esto ocurre porque la app no tiene un certificado de Apple Developer (que cuesta $99/ano), pero la app es completamente segura.

**Para solucionarlo, sigue estos pasos:**

1. **No** hagas click en "Mover al basurero" — dale a **Cancelar**
2. Abre la app **Terminal** (puedes buscarla en Spotlight con `Cmd + Espacio` y escribir "Terminal")
3. Copia y pega el siguiente comando en la Terminal y presiona **Enter**:

```bash
xattr -cr /Applications/Cartera.app
```

4. Cierra la Terminal
5. Abre la app normalmente — ahora deberia funcionar sin problemas

> Este paso solo es necesario **la primera vez** que instalas la app. Las actualizaciones posteriores no requieren repetirlo.

## Base de datos

La base de datos es un archivo SQLite (`cartera.db`) que se crea automaticamente la primera vez que abres la app.

| Sistema | Ubicacion por defecto |
|---|---|
| Windows | `%APPDATA%\cartera\cartera.db` |
| Mac | `~/Library/Application Support/cartera/cartera.db` |

Desde la seccion **Desarrollador** dentro de la app puedes cambiar la ubicacion de la base de datos a cualquier carpeta (por ejemplo, una carpeta de iCloud Drive o OneDrive para sincronizar entre equipos).

## Estructura del proyecto

```
├── desktop/
│   ├── main.js           # Ventana Electron + IPC handlers + auto-update
│   └── preload.js        # Bridge seguro entre Electron y frontend
├── backend/
│   ├── server.js         # Factory: abre la BD, arma el contexto y monta los routers
│   ├── core/             # engine (motor financiero puro) · atomic · cobros · errors · util
│   ├── db/               # schema (esquema y migraciones) · statements · housekeeping
│   └── routes/           # loans · payments · debts · recalculate · undo · vendor · config · activity
├── public/
│   ├── index.html        # Esqueleto HTML
│   ├── css/styles.css    # Hoja de estilos (temas claro/oscuro)
│   └── js/
│       ├── app.js        # Orquestador: estado global y composicion de vistas
│       ├── core/         # react · api · format · dominio · calculo · ui
│       ├── componentes/  # Ico · Modal/Fld/ABtn · SparklineChart · FlujoCajaPanel
│       ├── vistas/       # Las 9 vistas de la app
│       ├── modales/      # Los 13 modales
│       ├── pdf/          # Los 9 generadores de documentos
│       └── datos/        # changelogs
├── tests/                # Suite de verificacion (ver tests/README.md)
├── build/
│   ├── icon.ico          # Icono Windows
│   ├── icon.png          # Icono general
│   └── uninstaller.nsh   # Script de desinstalacion
└── .github/
    └── workflows/
        └── build.yml     # CI/CD: compila y publica releases
```

Modulos ES nativos, sin bundler ni paso de compilacion: la app se sirve por HTTP
desde el propio backend, asi que el navegador resuelve los `import` por si solo.

## Desarrollo local

```bash
# Instalar dependencias
npm install

# Ejecutar en modo desarrollo
npm start

# Compilar instaladores
npm run build:win    # Windows
npm run build:mac    # Mac
npm run build:all    # Ambos
```

## Stack tecnologico

| Componente | Tecnologia |
|---|---|
| Escritorio | Electron |
| Backend | Express (local en 127.0.0.1:3420) |
| Base de datos | SQLite (better-sqlite3) |
| Frontend | React 18 (UMD, sin build step) |
| Instalador | NSIS (Windows) / DMG (Mac) |
| Auto-update | electron-updater (Win) / custom updater (Mac) + GitHub Releases |

## Para desarrolladores

Toda la documentación interna vive en **`CLAUDE.md`**: arquitectura, esquema de BD, endpoints, modalidades, lógica de negocio, estado actual, historial de sprints, backlog y convenciones de trabajo.

---

Uso privado.
