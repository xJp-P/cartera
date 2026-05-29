# Cartera de Prestamos

App de escritorio para gestionar prestamos personales. Controla tu cartera de manera simple: registra prestamos, cobra cuotas, genera recibos y lleva el seguimiento de tus deudores.

## Funcionalidades

- **Prestamos en COP y USD** con conversion automatica via TRM (incluye compras fraccionadas a distintas tasas)
- **4 modalidades:** Intereses (plazo indefinido), Capital + Intereses (amortizacion francesa), Prestamo (0% interes), Pago Unico (una cuota en fecha exacta + ganancia pactada por % o monto fijo)
- **Frecuencia de cobro:** semanal, quincenal o mensual
- **Abonos a capital** con recalculo automatico del cronograma (mantener plazo, modificar plazo o fijar cuota)
- **Reestructuracion** de cronograma sin necesidad de abono (Capital + Intereses)
- **Recibos PDF** generados al registrar un pago
- **Cronograma PDF** con valor de liquidacion desde el perfil de cada deudor
- **Dashboard** con KPIs (capital original, recaudo del mes, saldo pendiente, ganancias, mora y proximos vencimientos), selector de meses en el recaudo para revisar periodos pasados y mini-graficos de tendencia en las tarjetas
- **Perfiles de deudores** con historial completo de creditos
- **Seccion de rendimiento** con ganancias por prestamo (intereses + ganancia/perdida por TRM en USD)
- **Calculadora** para simular prestamos antes de crearlos
- **Historial de acciones** (log de todo lo que hiciste)
- **Tema claro/oscuro** (PDFs se generan con el tema activo)
- **Actualizaciones automaticas** desde GitHub Releases (Windows y Mac), con arranque protegido que blinda la base de datos durante el chequeo de updates
- **Sincronizacion** via iCloud Drive, OneDrive, etc.

## Como instalar en Mac

Descarga el instalador desde [Releases](https://github.com/xJp-P/cartera-prestamos/releases):

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
xattr -cr /Applications/Cartera\ de\ Prestamos.app
```

4. Cierra la Terminal
5. Abre la app normalmente — ahora deberia funcionar sin problemas

> Este paso solo es necesario **la primera vez** que instalas la app. Las actualizaciones posteriores no requieren repetirlo.

## Base de datos

La base de datos es un archivo SQLite (`cartera.db`) que se crea automaticamente la primera vez que abres la app.

| Sistema | Ubicacion por defecto |
|---|---|
| Windows | `%APPDATA%\cartera-prestamos\cartera.db` |
| Mac | `~/Library/Application Support/cartera-prestamos/cartera.db` |

Desde la seccion **Desarrollador** dentro de la app puedes cambiar la ubicacion de la base de datos a cualquier carpeta (por ejemplo, una carpeta de iCloud Drive o OneDrive para sincronizar entre equipos).

## Estructura del proyecto

```
├── desktop/
│   ├── main.js           # Ventana Electron + IPC handlers + auto-update
│   └── preload.js        # Bridge seguro entre Electron y frontend
├── backend/
│   └── server.js         # API Express + SQLite + motor financiero
├── public/
│   └── index.html        # UI completa en React
├── build/
│   ├── icon.ico          # Icono Windows
│   ├── icon.png          # Icono general
│   └── uninstaller.nsh   # Script de desinstalacion
└── .github/
    └── workflows/
        └── build.yml     # CI/CD: compila y publica releases
```

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
