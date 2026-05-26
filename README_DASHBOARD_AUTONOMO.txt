DASHBOARD DOIT CRM/JIRA 2022-2026 - VERSION AUTONOMA

CAMBIO CLAVE RESPECTO A LA VERSION ANTERIOR
- Este dashboard NO usa fetch().
- No intenta leer crm_jira_2022_2026_editable.json desde file://.
- Por tanto no dispara errores CORS al abrirlo directamente con doble clic.

COMO SE USA
1. Abre dashboard_crm_jira_2022_2026_autonomo.html directamente en Chrome/Edge.
2. Los datos base ya van embebidos dentro del HTML.
3. Edita ficha de cliente, centro o parametros internos de EPIC.
4. Al pulsar Guardar, el cambio se guarda automaticamente en el navegador como parche local.
5. Cuando quieras persistir fuera del navegador, pulsa Exportar JSON actualizado.

IMPORTANTE
- Un navegador no puede sobrescribir automaticamente un archivo JSON local por seguridad.
- La estrategia robusta es: HTML autonomo + parches en localStorage + exportacion manual del JSON actualizado.
- El JSON exportado contiene la base completa con tus cambios aplicados.

ARCHIVOS
- dashboard_v2.html: última versión.
- dashboard_crm_jira_2022_2026_autonomo.html: dashboard principal autonomo.
- crm_jira_2022_2026_base_autonomo.json: copia de la base inicial, solo como respaldo/documentacion.

RECOMENDACION OPERATIVA
Guarda siempre el ultimo JSON exportado con fecha o version. Si quieres que el proximo dashboard arranque con esa version como base, usa ese JSON como fuente para regenerar un nuevo HTML autonomo.
