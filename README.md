# Cartera de Prestamos

App de escritorio para gestionar prestamos personales. Controla tu cartera de manera simple: registra prestamos, cobra cuotas, genera recibos y lleva el seguimiento de tus deudores.

## Funcionalidades

- **Prestamos en COP y USD** con conversion automatica via TRM
- **3 modalidades:** Intereses (plazo indefinido), Capital + Intereses (amortizacion francesa), Prestamo (0% interes)
- **Frecuencia de cobro:** semanal, quincenal o mensual
- **Abonos a capital** con recalculo automatico del cronograma
- **Recibos PDF** generados al registrar un pago
- **Dashboard** con KPIs: cartera activa, mora, recaudo del mes, proximos vencimientos
- **Perfiles de deudores** con historial completo de creditos
- **Seccion de rendimiento** con ganancias por prestamo
- **Calculadora** para simular prestamos antes de crearlos
- **Historial de acciones** (log de todo lo que hiciste)
- **Tema claro/oscuro**
- **Actualizaciones automaticas** desde GitHub Releases
- **Sincronizacion** via iCloud Drive, OneDrive, etc.

## Capturas

*Proximamente*

## Instalacion

Descarga el instalador desde [Releases](https://github.com/xJp-P/cartera-prestamos/releases):

- **Windows:** `Instalador.Windows.exe`
- **Mac:** `Instalador.Mac.dmg`

La app se actualiza automaticamente cuando hay una nueva version disponible.

## Stack

| Componente | Tecnologia |
|---|---|
| Escritorio | Electron |
| Backend | Express (local en 127.0.0.1:3420) |
| Base de datos | SQLite (better-sqlite3) |
| Frontend | React 18 (UMD, sin build step) |
| Instalador | NSIS (Windows) / DMG (Mac) |
| Auto-update | electron-updater + GitHub Releases |

## Desarrollo

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

## Estructura del proyecto

```
├── main.js           # Ventana Electron + IPC handlers
├── server.js         # API Express + SQLite + motor financiero
├── preload.js        # Bridge seguro entre Electron y frontend
├── public/
│   └── index.html    # UI completa en React
├── build/
│   ├── icon.ico      # Icono Windows
│   ├── icon.png      # Icono general
│   └── uninstaller.nsh  # Script de desinstalacion
└── .github/
    └── workflows/
        └── build.yml # CI/CD: compila y publica releases
```

## Licencia

Uso privado.
