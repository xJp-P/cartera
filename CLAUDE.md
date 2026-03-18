# 💼 Aplicación Electron: Cartera de Préstamos

## Descripción General
Aplicación nativa construida con **Electron** para gestionar préstamos, intereses, cuotas y pagos. Migrada desde un Excel con macros limitantes. Los datos se guardan localmente en el navegador.

## Origen del Proyecto
- **Inicio**: Excel (Cartera_Prestamos.xlsm) con 15 préstamos activos
- **Problema**: Macros muy limitantes, dificultad para control de pagos y proyecciones
- **Solución**: Aplicación Electron para mejor UX y flexibilidad
- **Estado actual**: Funcional con todas las características principales implementadas

## Características Principales

### 1. **Cartera** 📋
- Agregar nuevos préstamos con formulario completo
- Soporta dos modalidades:
  - **Solo Intereses**: Cuota fija de intereses + capital al final
  - **Capital + Intereses**: Amortización francesa (fórmula PMT)
- Manejo de préstamos en USD con TRM
- Generación automática de cronograma de amortización
- Expandir préstamo para ver tabla de amortización completa

### 2. **Pagos** ✅
- Lista completa de todas las cuotas del sistema
- Filtros por:
  - Cliente
  - Estado (Pendiente, Pagada, En Mora)
  - Mes
- Panel para marcar cuota como:
  - **Pagada** (con fecha de recaudo)
  - **En Mora** (automático al vencer)
  - **Pendiente** (revertir estado)
- Campo de observaciones por pago

### 3. **Proyección** 📈
- Tabla mensual con flujo de caja
- Comparación: Flujo esperado vs. flujo recibido
- Porcentaje de recaudo por mes
- Conteo de cuotas en mora
- Resaltado del mes actual

### 4. **Alertas Automáticas** 🚨
- Detección de mora automática al abrir app
- Cuotas vencidas sin pagar → marcadas como "En Mora"
- Alerta roja en header cuando hay cuotas en mora

## Arquitectura Técnica

**Stack:**
- Electron (aplicación nativa)
- React (UI)
- Node.js (backend / server.js)
- localStorage (persistencia de datos local)

**Archivos principales:**
- `server.js` - Servidor Electron
- `public/index.html` - UI de React compilada inline

**Persistencia:**
- Los datos se guardan en localStorage del navegador
- Persisten entre sesiones

## Estado Actual del Código

### Último fix (Sesión anterior)
- **Problema**: Sintaxis error en línea 399
- **Causa**: Comilla de cierre faltante en `'var(--text2)'`
- **Estado**: ✅ CORREGIDO - JavaScript validado

### Ejecución
```bash
npm start
```

## Próximas Optimizaciones / Características Planificadas
- [ ] Exportar datos (CSV/PDF)
- [ ] Gráficos de análisis de mora
- [ ] Notificaciones de cuotas próximas a vencer
- [ ] Búsqueda avanzada en cuotas
- [ ] Respaldo automático en nube

## Notas de Desarrollo

### Datos Locales
- Se guardan en `localStorage`
- Limpiar `localStorage` resetea toda la app
- Para debug: Abre DevTools → Application → LocalStorage

### Fórmulas Utilizadas
- **PMT (cuota uniforme)**: `r * pv / (1 - (1 + r)^-n)`
  - r = tasa mensual
  - pv = capital
  - n = número de cuotas

### Flujo Típico de Usuario
1. Agregar préstamos en "Cartera"
2. Sistema genera cronograma automático
3. Marcar pagos en "Pagos" conforme se recaudan
4. Revisar proyección en "Proyección"
5. Alertas automáticas en caso de mora

## Instrucciones para Claude Code

Cuando abras Claude Code en esta carpeta:

1. **Entiende el contexto**: Esta app gestiona préstamos con dos modalidades de cálculo
2. **Respeta la estructura**: No reorganices drasticamente el código
3. **Prueba cambios**: Ejecuta `npm start` para validar cambios
4. **Valida JavaScript**: Los inline scripts deben pasar `node --check`
5. **Preserva localStorage**: No elimines el sistema de persistencia sin alternativa

---

**Última actualización**: Marzo 16, 2026
**Ubicación del proyecto**: C:\Users\juanp\Documents\iCloudDrive\App_Ptm
