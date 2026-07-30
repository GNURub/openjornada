package mcpserver

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type toolSpec struct {
	name        string
	title       string
	description string
	readOnly    bool
	destructive bool
	properties  map[string]any
	required    []string
}

func (s *Service) serverFor(p *principal) *mcp.Server {
	server := mcp.NewServer(
		&mcp.Implementation{Name: "OpenJornada", Version: serverVersion},
		&mcp.ServerOptions{Instructions: "Gestiona exclusivamente la organización del token. No inventes identificadores: consulta primero las herramientas de lectura. Confirma con la persona usuaria antes de operaciones destructivas o resoluciones."},
	)
	for _, spec := range toolCatalog() {
		current := spec
		server.AddTool(&mcp.Tool{
			Name:        current.name,
			Title:       current.title,
			Description: current.description,
			InputSchema: objectSchema(current.properties, current.required),
			Annotations: &mcp.ToolAnnotations{
				Title:           current.title,
				ReadOnlyHint:    current.readOnly,
				DestructiveHint: boolPointer(current.destructive),
				OpenWorldHint:   boolPointer(false),
				IdempotentHint:  current.readOnly,
			},
		}, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args, err := decodeArgs(request.Params.Arguments)
			if err != nil {
				s.audit(p, current.name, "error", nil)
				return toolError(err), nil
			}
			value, ids, err := s.callTool(ctx, p, current.name, args)
			if err != nil {
				s.audit(p, current.name, "error", ids)
				return toolError(err), nil
			}
			s.audit(p, current.name, "success", ids)
			return toolResult(value), nil
		})
	}
	return server
}

func toolCatalog() []toolSpec {
	page := map[string]any{
		"pagina":     integerProperty("Página, desde 1."),
		"por_pagina": integerProperty("Resultados por página, máximo 100."),
	}
	list := func(name, title, description string, extra map[string]any) toolSpec {
		properties := map[string]any{}
		for key, value := range page {
			properties[key] = value
		}
		for key, value := range extra {
			properties[key] = value
		}
		return toolSpec{name: name, title: title, description: description, readOnly: true, properties: properties}
	}
	write := func(name, title, description string, properties map[string]any, required []string, destructive bool) toolSpec {
		return toolSpec{name: name, title: title, description: description, properties: properties, required: required, destructive: destructive}
	}
	identifier := stringProperty("Identificador PocketBase del registro.")
	person := stringProperty("Identificador de la persona.")
	status := stringProperty("Estado por el que filtrar.")
	from := stringProperty("Fecha inicial YYYY-MM-DD.")
	to := stringProperty("Fecha final YYYY-MM-DD.")

	return []toolSpec{
		{name: "obtener_contexto", title: "Obtener contexto", description: "Devuelve la identidad, el rol y la organización asociados al token MCP.", readOnly: true, properties: map[string]any{}},
		list("listar_personas", "Listar personas", "Lista el personal visible de la organización.", map[string]any{"rol": stringProperty("Rol opcional."), "activas": booleanProperty("Filtrar cuentas activas o inactivas.")}),
		write("crear_persona", "Crear persona", "Crea una persona en la organización y, salvo que se indique lo contrario, envía su invitación.", map[string]any{
			"nombre": stringProperty("Nombre completo."), "email": stringProperty("Correo electrónico."), "rol": enumProperty("admin", "employee", "manager", "representative"),
			"codigo": stringProperty("Código de empleado opcional."), "puesto": stringProperty("Puesto opcional."), "horas_semanales": numberProperty("Horas semanales."), "enviar_invitacion": booleanProperty("Enviar invitación inmediatamente."),
		}, []string{"nombre", "email", "rol"}, false),
		write("actualizar_persona", "Actualizar persona", "Actualiza datos laborales, rol o estado activo de una persona. No cambia credenciales.", map[string]any{
			"persona_id": identifier, "nombre": stringProperty("Nombre completo."), "rol": enumProperty("admin", "manager", "employee", "representative"), "activa": booleanProperty("Estado activo."),
			"codigo": stringProperty("Código de empleado."), "puesto": stringProperty("Puesto."), "horas_semanales": numberProperty("Horas semanales."),
		}, []string{"persona_id"}, true),
		write("enviar_invitacion", "Enviar invitación", "Emite una nueva invitación de acceso para una persona existente.", map[string]any{"persona_id": identifier}, []string{"persona_id"}, false),

		list("consultar_hoja_jornada", "Consultar hoja de jornada", "Calcula la hoja de jornada de una persona en un intervalo.", map[string]any{"persona_id": person, "desde": from, "hasta": to}),
		list("listar_eventos_jornada", "Listar eventos de jornada", "Lista fichajes inmutables dentro de un intervalo.", map[string]any{"persona_id": person, "desde": from, "hasta": to, "tipo": stringProperty("Tipo de evento opcional.")}),
		list("listar_solicitudes_jornada", "Listar solicitudes de jornada", "Lista altas manuales y correcciones completas de jornada.", map[string]any{"persona_id": person, "estado": status}),
		write("resolver_solicitud_jornada", "Resolver solicitud de jornada", "Aprueba o rechaza una solicitud manual o corrección completa, aplicando los controles del servidor.", map[string]any{"solicitud_id": identifier, "estado": enumProperty("approved", "rejected"), "nota": stringProperty("Nota de resolución.")}, []string{"solicitud_id", "estado"}, true),
		list("listar_solicitudes_correccion", "Listar correcciones de fichaje", "Lista solicitudes de corrección de eventos concretos.", map[string]any{"persona_id": person, "estado": status}),
		write("resolver_solicitud_correccion", "Resolver corrección de fichaje", "Aprueba o rechaza una corrección de un evento de jornada.", map[string]any{"solicitud_id": identifier, "estado": enumProperty("approved", "rejected"), "nota": stringProperty("Nota de resolución.")}, []string{"solicitud_id", "estado"}, true),
		{name: "generar_informe_jornada", title: "Generar informe de jornada", description: "Calcula totales y detalle de jornada para una persona o para todo el personal activo en un intervalo.", readOnly: true, properties: map[string]any{"persona_id": person, "desde": from, "hasta": to}, required: []string{"desde", "hasta"}},

		list("listar_horarios", "Listar horarios", "Lista horarios laborales asignados.", map[string]any{"persona_id": person, "activos": booleanProperty("Filtrar por estado activo.")}),
		write("asignar_horario", "Asignar horario", "Crea el mismo horario para una o varias personas.", map[string]any{
			"personas_ids": arrayProperty("Identificadores de 1 a 200 personas."), "nombre": stringProperty("Nombre del horario."), "vigente_desde": from, "vigente_hasta": to,
			"dias_semana": numberArrayProperty("Días de la semana de 0 (domingo) a 6."), "hora_inicio": stringProperty("Hora HH:MM."), "hora_fin": stringProperty("Hora HH:MM."), "minutos_pausa": numberProperty("Pausa prevista."),
		}, []string{"personas_ids", "nombre", "vigente_desde", "dias_semana", "hora_inicio", "hora_fin"}, false),
		write("cambiar_estado_horario", "Cambiar estado de horario", "Activa o desactiva un horario existente.", map[string]any{"horario_id": identifier, "activo": booleanProperty("Nuevo estado.")}, []string{"horario_id", "activo"}, true),

		list("listar_ausencias", "Listar ausencias", "Lista solicitudes y asignaciones de ausencias o vacaciones.", map[string]any{"persona_id": person, "estado": status, "desde": from, "hasta": to}),
		list("consultar_calendario_ausencias", "Consultar calendario de ausencias", "Devuelve ausencias aprobadas, festivos y periodos bloqueados para un intervalo.", map[string]any{"desde": from, "hasta": to}),
		list("listar_saldos_ausencia", "Listar saldos de ausencia", "Lista saldos de ausencia por persona, tipo y año.", map[string]any{"persona_id": person, "anio": integerProperty("Año.")}),
		write("asignar_ausencia", "Asignar ausencia", "Crea una ausencia para una persona como administración o responsable.", map[string]any{
			"persona_id": person, "tipo_ausencia_id": identifier, "desde": from, "hasta": to, "parte_dia": enumProperty("full", "morning", "afternoon"), "motivo": stringProperty("Motivo opcional."),
		}, []string{"persona_id", "tipo_ausencia_id", "desde", "hasta", "parte_dia"}, false),
		write("resolver_solicitud_ausencia", "Resolver solicitud de ausencia", "Aprueba o rechaza una solicitud de ausencia pendiente.", map[string]any{"solicitud_id": identifier, "estado": enumProperty("approved", "rejected"), "respuesta": stringProperty("Respuesta para la persona.")}, []string{"solicitud_id", "estado"}, true),
		write("obtener_adjunto_ausencia", "Obtener adjunto de ausencia", "Genera una URL firmada de cinco minutos para descargar el adjunto protegido.", map[string]any{"solicitud_id": identifier}, []string{"solicitud_id"}, false),

		list("listar_gastos", "Listar gastos", "Lista gastos y sus justificantes disponibles.", map[string]any{"persona_id": person, "estado": status, "desde": from, "hasta": to}),
		write("resolver_gasto", "Resolver gasto", "Cambia el estado de revisión de un gasto. Solo administración puede marcarlo como pagado.", map[string]any{"gasto_id": identifier, "estado": enumProperty("changes_requested", "approved", "rejected", "paid"), "comentario": stringProperty("Comentario de revisión.")}, []string{"gasto_id", "estado"}, true),
		write("obtener_justificante_gasto", "Obtener justificante de gasto", "Genera una URL firmada de cinco minutos para un justificante protegido.", map[string]any{"gasto_id": identifier}, []string{"gasto_id"}, false),

		list("listar_directorios", "Listar directorios", "Lista directorios documentales y sus reglas de visibilidad.", map[string]any{}),
		write("crear_directorio", "Crear directorio", "Crea un directorio documental.", map[string]any{"nombre": stringProperty("Nombre."), "visibilidad": enumProperty("company", "selected", "management"), "personas_ids": arrayProperty("Personas con acceso cuando la visibilidad es selected.")}, []string{"nombre", "visibilidad"}, false),
		write("actualizar_directorio", "Actualizar directorio", "Actualiza nombre, visibilidad y personas permitidas.", map[string]any{"directorio_id": identifier, "nombre": stringProperty("Nombre."), "visibilidad": enumProperty("company", "selected", "management"), "personas_ids": arrayProperty("Personas permitidas.")}, []string{"directorio_id"}, true),
		write("eliminar_directorio", "Eliminar directorio", "Elimina un directorio vacío.", map[string]any{"directorio_id": identifier}, []string{"directorio_id"}, true),
		list("listar_documentos", "Listar documentos", "Lista documentos visibles y metadatos, sin exponer el archivo directamente.", map[string]any{"persona_id": person, "directorio_id": identifier, "categoria": stringProperty("Categoría opcional.")}),
		write("subir_documento", "Subir documento", "Sube un documento protegido a una persona o directorio. El contenido debe enviarse en base64 y no superar 15 MiB.", map[string]any{
			"nombre_archivo": stringProperty("Nombre seguro con extensión."), "contenido_base64": stringProperty("Contenido del archivo en base64."), "titulo": stringProperty("Título."), "categoria": enumProperty("contract", "payroll", "identity", "medical", "training", "other"),
			"visibilidad": enumProperty("employee", "company", "management", "folder"), "persona_id": person, "directorio_id": identifier, "requiere_confirmacion": booleanProperty("Requiere confirmación de lectura."),
		}, []string{"nombre_archivo", "contenido_base64", "titulo", "categoria", "visibilidad"}, false),
		write("mover_documento", "Mover documento", "Mueve un documento entre una persona, la empresa o un directorio.", map[string]any{"documento_id": identifier, "persona_id": person, "directorio_id": identifier, "visibilidad": enumProperty("employee", "company", "management", "folder")}, []string{"documento_id", "visibilidad"}, true),
		write("obtener_documento", "Obtener documento", "Genera una URL firmada de cinco minutos para descargar un documento protegido.", map[string]any{"documento_id": identifier}, []string{"documento_id"}, false),
		list("listar_confirmaciones_documento", "Listar confirmaciones", "Lista confirmaciones de lectura documental.", map[string]any{"documento_id": identifier, "persona_id": person}),

		list("listar_tareas", "Listar tareas", "Lista tareas del personal.", map[string]any{"persona_id": person, "estado": status}),
		write("crear_tarea", "Crear tarea", "Asigna una tarea a una persona.", map[string]any{"persona_id": person, "titulo": stringProperty("Título."), "descripcion": stringProperty("Descripción."), "categoria": enumProperty("onboarding", "training", "administrative", "other"), "fecha_limite": to, "obligatoria": booleanProperty("Indica si es obligatoria.")}, []string{"persona_id", "titulo", "categoria"}, false),
		write("actualizar_estado_tarea", "Actualizar estado de tarea", "Cambia el estado de una tarea.", map[string]any{"tarea_id": identifier, "estado": enumProperty("pending", "in_progress", "completed", "cancelled")}, []string{"tarea_id", "estado"}, true),
		list("listar_objetivos", "Listar objetivos", "Lista objetivos del personal.", map[string]any{"persona_id": person, "estado": status}),
		write("crear_objetivo", "Crear objetivo", "Crea un objetivo para una persona.", map[string]any{"persona_id": person, "titulo": stringProperty("Título."), "descripcion": stringProperty("Descripción."), "ciclo": stringProperty("Ciclo de evaluación."), "fecha_limite": to, "progreso": numberProperty("Progreso de 0 a 100."), "estado": enumProperty("draft", "active", "completed", "cancelled"), "publico": booleanProperty("Visible para la organización.")}, []string{"persona_id", "titulo", "ciclo"}, false),
		write("actualizar_progreso_objetivo", "Actualizar progreso de objetivo", "Actualiza progreso y estado de un objetivo.", map[string]any{"objetivo_id": identifier, "progreso": numberProperty("Progreso de 0 a 100."), "estado": enumProperty("draft", "active", "completed", "cancelled")}, []string{"objetivo_id", "progreso"}, true),

		list("listar_avisos", "Listar avisos", "Lista avisos publicados en la organización.", map[string]any{}),
		write("publicar_aviso", "Publicar aviso", "Publica un aviso interno y puede activar su envío por correo.", map[string]any{"titulo": stringProperty("Título."), "contenido": stringProperty("Contenido."), "audiencia": enumProperty("all", "employees", "managers"), "enviar_email": booleanProperty("Enviar por correo.")}, []string{"titulo", "contenido", "audiencia"}, false),
		write("actualizar_aviso", "Actualizar aviso", "Actualiza el contenido o audiencia de un aviso.", map[string]any{"aviso_id": identifier, "titulo": stringProperty("Título."), "contenido": stringProperty("Contenido."), "audiencia": enumProperty("all", "employees", "managers")}, []string{"aviso_id"}, true),
	}
}

func (s *Service) callTool(ctx context.Context, p *principal, name string, a map[string]any) (any, []string, error) {
	switch name {
	case "obtener_contexto":
		organization, err := s.doJSON(ctx, p.actor, http.MethodGet, collectionPath("organizations", p.actor.GetString("organization")), nil, nil)
		return map[string]any{"actor": publicActor(p), "organization": organization, "mcp": map[string]any{"version": serverVersion, "tokenExpiresAt": p.token.GetDateTime("expiresAt").String()}}, nil, err
	case "listar_personas":
		filters := []string{filterEqual("role", stringArg(a, "rol"))}
		if active, ok := a["activas"].(bool); ok {
			filters = append(filters, fmt.Sprintf("active = %t", active))
		}
		return s.list(ctx, p, "users", a, filters, "name", "")
	case "crear_persona":
		return s.createPerson(ctx, p, a)
	case "actualizar_persona":
		return s.patchFields(ctx, p, "users", stringArg(a, "persona_id"), personPatch(a))
	case "enviar_invitacion":
		return s.customPost(ctx, p, "/api/openjornada/team/"+url.PathEscape(stringArg(a, "persona_id"))+"/invitation", nil, stringArg(a, "persona_id"))
	case "consultar_hoja_jornada":
		query := url.Values{"from": {stringArg(a, "desde")}, "to": {stringArg(a, "hasta")}}
		if employee := stringArg(a, "persona_id"); employee != "" {
			query.Set("employee", employee)
		}
		value, err := s.doJSON(ctx, p.actor, http.MethodGet, "/api/openjornada/timesheet", query, nil)
		return value, nonEmpty(stringArg(a, "persona_id")), err
	case "listar_eventos_jornada":
		return s.list(ctx, p, "work_events", a, nonEmpty(filterEqual("employee", stringArg(a, "persona_id")), filterEqual("kind", stringArg(a, "tipo")), filterDate("occurredAt", ">=", stringArg(a, "desde")), filterDate("occurredAt", "<=", stringArg(a, "hasta"))), "-occurredAt", "employee,breakType")
	case "listar_solicitudes_jornada":
		return s.list(ctx, p, "manual_time_requests", a, nonEmpty(filterEqual("employee", stringArg(a, "persona_id")), filterEqual("status", stringArg(a, "estado"))), "-created", "employee,resolvedBy")
	case "resolver_solicitud_jornada":
		id := stringArg(a, "solicitud_id")
		return s.customPost(ctx, p, "/api/openjornada/manual-time-requests/"+url.PathEscape(id)+"/resolve", map[string]any{"status": stringArg(a, "estado"), "resolutionNote": stringArg(a, "nota")}, id)
	case "listar_solicitudes_correccion":
		return s.list(ctx, p, "correction_requests", a, nonEmpty(filterEqual("employee", stringArg(a, "persona_id")), filterEqual("status", stringArg(a, "estado"))), "-created", "employee,workEvent,resolvedBy")
	case "resolver_solicitud_correccion":
		id := stringArg(a, "solicitud_id")
		body := map[string]any{"status": stringArg(a, "estado"), "resolutionNote": stringArg(a, "nota"), "resolvedBy": p.actor.Id, "resolvedAt": time.Now()}
		return s.patchFields(ctx, p, "correction_requests", id, body)
	case "generar_informe_jornada":
		return s.timesheetReport(ctx, p, a)
	case "listar_horarios":
		filters := []string{filterEqual("employee", stringArg(a, "persona_id"))}
		if active, ok := a["activos"].(bool); ok {
			filters = append(filters, fmt.Sprintf("active = %t", active))
		}
		return s.list(ctx, p, "work_schedules", a, nonEmpty(filters...), "-validFrom", "employee")
	case "asignar_horario":
		body := map[string]any{"employeeIds": stringSliceArg(a, "personas_ids"), "name": stringArg(a, "nombre"), "validFrom": stringArg(a, "vigente_desde"), "validUntil": stringArg(a, "vigente_hasta"), "weekdays": a["dias_semana"], "startTime": stringArg(a, "hora_inicio"), "endTime": stringArg(a, "hora_fin"), "breakMinutes": numberArg(a, "minutos_pausa", 0)}
		value, err := s.doJSON(ctx, p.actor, http.MethodPost, "/api/openjornada/work-schedules/bulk", nil, body)
		return value, stringSliceArg(a, "personas_ids"), err
	case "cambiar_estado_horario":
		return s.patchFields(ctx, p, "work_schedules", stringArg(a, "horario_id"), map[string]any{"active": boolArg(a, "activo", false)})
	case "listar_ausencias":
		return s.list(ctx, p, "leave_requests", a, nonEmpty(filterEqual("employee", stringArg(a, "persona_id")), filterEqual("status", stringArg(a, "estado")), filterDate("endDate", ">=", stringArg(a, "desde")), filterDate("startDate", "<=", stringArg(a, "hasta"))), "-startDate", "employee,leaveType,reviewedBy")
	case "consultar_calendario_ausencias":
		return s.leaveCalendar(ctx, p, a)
	case "listar_saldos_ausencia":
		filters := []string{filterEqual("employee", stringArg(a, "persona_id"))}
		if year := int(numberArg(a, "anio", 0)); year > 0 {
			filters = append(filters, fmt.Sprintf("year = %d", year))
		}
		return s.list(ctx, p, "leave_balances", a, nonEmpty(filters...), "-year", "employee,leaveType")
	case "asignar_ausencia":
		body := map[string]any{"organization": p.actor.GetString("organization"), "employee": stringArg(a, "persona_id"), "leaveType": stringArg(a, "tipo_ausencia_id"), "startDate": stringArg(a, "desde"), "endDate": stringArg(a, "hasta"), "dayPart": stringArg(a, "parte_dia"), "reason": stringArg(a, "motivo"), "status": "approved", "assignedBy": p.actor.Id}
		return s.createRecord(ctx, p, "leave_requests", body, stringArg(a, "persona_id"))
	case "resolver_solicitud_ausencia":
		id := stringArg(a, "solicitud_id")
		body := map[string]any{"status": stringArg(a, "estado"), "response": stringArg(a, "respuesta"), "reviewedBy": p.actor.Id, "reviewedAt": time.Now()}
		return s.patchFields(ctx, p, "leave_requests", id, body)
	case "obtener_adjunto_ausencia":
		return s.fileLink(ctx, p, "leave_requests", stringArg(a, "solicitud_id"), "attachment")
	case "listar_gastos":
		return s.list(ctx, p, "expenses", a, nonEmpty(filterEqual("employee", stringArg(a, "persona_id")), filterEqual("status", stringArg(a, "estado")), filterDate("expenseDate", ">=", stringArg(a, "desde")), filterDate("expenseDate", "<=", stringArg(a, "hasta"))), "-expenseDate", "employee,category,reviewedBy")
	case "resolver_gasto":
		id, next := stringArg(a, "gasto_id"), stringArg(a, "estado")
		if next == "paid" && p.actor.GetString("role") != "admin" {
			return nil, []string{id}, fmt.Errorf("solo administración puede marcar un gasto como pagado")
		}
		body := map[string]any{"status": next, "reviewComment": stringArg(a, "comentario"), "reviewedBy": p.actor.Id, "reviewedAt": time.Now()}
		if next == "paid" {
			body["paidAt"] = time.Now()
		}
		return s.patchFields(ctx, p, "expenses", id, body)
	case "obtener_justificante_gasto":
		return s.fileLink(ctx, p, "expenses", stringArg(a, "gasto_id"), "receipt")
	case "listar_directorios":
		return s.list(ctx, p, "document_folders", a, nil, "name", "allowedUsers,createdBy")
	case "crear_directorio":
		body := map[string]any{"organization": p.actor.GetString("organization"), "name": stringArg(a, "nombre"), "visibility": stringArg(a, "visibilidad"), "allowedUsers": stringSliceArg(a, "personas_ids"), "createdBy": p.actor.Id}
		return s.createRecord(ctx, p, "document_folders", body, "")
	case "actualizar_directorio":
		body := presentFields(a, map[string]string{"nombre": "name", "visibilidad": "visibility", "personas_ids": "allowedUsers"})
		return s.patchFields(ctx, p, "document_folders", stringArg(a, "directorio_id"), body)
	case "eliminar_directorio":
		id := stringArg(a, "directorio_id")
		value, err := s.doJSON(ctx, p.actor, http.MethodDelete, collectionPath("document_folders", id), nil, nil)
		return value, []string{id}, err
	case "listar_documentos":
		return s.list(ctx, p, "employee_documents", a, nonEmpty(filterEqual("employee", stringArg(a, "persona_id")), filterEqual("folder", stringArg(a, "directorio_id")), filterEqual("category", stringArg(a, "categoria"))), "-created", "employee,folder,uploadedBy")
	case "subir_documento":
		return s.uploadDocument(ctx, p, a)
	case "mover_documento":
		body := map[string]any{"visibility": stringArg(a, "visibilidad"), "employee": stringArg(a, "persona_id"), "folder": stringArg(a, "directorio_id")}
		return s.patchFields(ctx, p, "employee_documents", stringArg(a, "documento_id"), body)
	case "obtener_documento":
		return s.fileLink(ctx, p, "employee_documents", stringArg(a, "documento_id"), "file")
	case "listar_confirmaciones_documento":
		return s.list(ctx, p, "document_acknowledgements", a, nonEmpty(filterEqual("document", stringArg(a, "documento_id")), filterEqual("user", stringArg(a, "persona_id"))), "created", "document,user")
	case "listar_tareas":
		return s.list(ctx, p, "employee_tasks", a, nonEmpty(filterEqual("assignee", stringArg(a, "persona_id")), filterEqual("status", stringArg(a, "estado"))), "dueDate", "assignee,createdBy")
	case "crear_tarea":
		body := map[string]any{"organization": p.actor.GetString("organization"), "assignee": stringArg(a, "persona_id"), "title": stringArg(a, "titulo"), "description": stringArg(a, "descripcion"), "category": stringArg(a, "categoria"), "dueDate": stringArg(a, "fecha_limite"), "required": boolArg(a, "obligatoria", false), "status": "pending", "createdBy": p.actor.Id}
		return s.createRecord(ctx, p, "employee_tasks", body, stringArg(a, "persona_id"))
	case "actualizar_estado_tarea":
		body := map[string]any{"status": stringArg(a, "estado")}
		if stringArg(a, "estado") == "completed" {
			body["completedAt"] = time.Now()
		} else {
			body["completedAt"] = ""
		}
		return s.patchFields(ctx, p, "employee_tasks", stringArg(a, "tarea_id"), body)
	case "listar_objetivos":
		return s.list(ctx, p, "goals", a, nonEmpty(filterEqual("employee", stringArg(a, "persona_id")), filterEqual("status", stringArg(a, "estado"))), "dueDate", "employee,createdBy")
	case "crear_objetivo":
		body := map[string]any{"organization": p.actor.GetString("organization"), "employee": stringArg(a, "persona_id"), "title": stringArg(a, "titulo"), "description": stringArg(a, "descripcion"), "cycle": stringArg(a, "ciclo"), "dueDate": stringArg(a, "fecha_limite"), "progress": numberArg(a, "progreso", 0), "status": fallbackString(stringArg(a, "estado"), "draft"), "public": boolArg(a, "publico", false), "createdBy": p.actor.Id}
		return s.createRecord(ctx, p, "goals", body, stringArg(a, "persona_id"))
	case "actualizar_progreso_objetivo":
		body := map[string]any{"progress": numberArg(a, "progreso", 0)}
		if state := stringArg(a, "estado"); state != "" {
			body["status"] = state
		}
		return s.patchFields(ctx, p, "goals", stringArg(a, "objetivo_id"), body)
	case "listar_avisos":
		return s.list(ctx, p, "announcements", a, nil, "-publishedAt", "createdBy")
	case "publicar_aviso":
		body := map[string]any{"organization": p.actor.GetString("organization"), "title": stringArg(a, "titulo"), "body": stringArg(a, "contenido"), "audience": stringArg(a, "audiencia"), "sendEmail": boolArg(a, "enviar_email", false), "createdBy": p.actor.Id, "publishedAt": time.Now()}
		return s.createRecord(ctx, p, "announcements", body, "")
	case "actualizar_aviso":
		return s.patchFields(ctx, p, "announcements", stringArg(a, "aviso_id"), presentFields(a, map[string]string{"titulo": "title", "contenido": "body", "audiencia": "audience"}))
	default:
		return nil, nil, fmt.Errorf("herramienta no implementada")
	}
}

func (s *Service) list(ctx context.Context, p *principal, collection string, a map[string]any, filters []string, sort, expand string) (any, []string, error) {
	value, err := s.doJSON(ctx, p.actor, http.MethodGet, collectionPath(collection), listQuery(a, filters, sort, expand), nil)
	return value, nil, err
}

func (s *Service) createRecord(ctx context.Context, p *principal, collection string, body map[string]any, target string) (any, []string, error) {
	value, err := s.doJSON(ctx, p.actor, http.MethodPost, collectionPath(collection), nil, body)
	return value, nonEmpty(target), err
}

func (s *Service) patchFields(ctx context.Context, p *principal, collection, id string, body map[string]any) (any, []string, error) {
	if id == "" {
		return nil, nil, fmt.Errorf("falta el identificador")
	}
	if len(body) == 0 {
		return nil, []string{id}, fmt.Errorf("no se ha indicado ningún cambio")
	}
	value, err := s.doJSON(ctx, p.actor, http.MethodPatch, collectionPath(collection, id), nil, body)
	return value, []string{id}, err
}

func (s *Service) customPost(ctx context.Context, p *principal, path string, body any, id string) (any, []string, error) {
	value, err := s.doJSON(ctx, p.actor, http.MethodPost, path, nil, body)
	return value, nonEmpty(id), err
}

func (s *Service) createPerson(ctx context.Context, p *principal, a map[string]any) (any, []string, error) {
	name, err := requiredString(a, "nombre", "nombre")
	if err != nil {
		return nil, nil, err
	}
	email, err := requiredString(a, "email", "email")
	if err != nil {
		return nil, nil, err
	}
	role, err := requiredString(a, "rol", "rol")
	if err != nil {
		return nil, nil, err
	}
	if p.actor.GetString("role") == "manager" && role != "employee" {
		return nil, nil, fmt.Errorf("un responsable solo puede crear cuentas de empleado")
	}
	password, err := randomURLString(32)
	if err != nil {
		return nil, nil, err
	}
	body := map[string]any{
		"organization": p.actor.GetString("organization"), "name": name, "email": email,
		"role": role, "active": true, "password": password, "passwordConfirm": password,
		"employeeCode": stringArg(a, "codigo"), "jobTitle": stringArg(a, "puesto"), "weeklyHours": numberArg(a, "horas_semanales", 40),
	}
	created, err := s.doJSON(ctx, p.actor, http.MethodPost, collectionPath("users"), nil, body)
	if err != nil {
		return nil, nil, err
	}
	record, _ := created.(map[string]any)
	id, _ := record["id"].(string)
	if boolArg(a, "enviar_invitacion", true) && id != "" {
		invitation, inviteErr := s.doJSON(ctx, p.actor, http.MethodPost, "/api/openjornada/team/"+url.PathEscape(id)+"/invitation", nil, nil)
		if inviteErr != nil {
			return map[string]any{
				"persona": created,
				"warning": "La persona se ha creado, pero no se pudo enviar la invitación: " + inviteErr.Error(),
			}, []string{id}, nil
		}
		return map[string]any{"persona": created, "invitacion": invitation}, []string{id}, nil
	}
	return created, nonEmpty(id), nil
}

func personPatch(a map[string]any) map[string]any {
	return presentFields(a, map[string]string{
		"nombre": "name", "rol": "role", "activa": "active", "codigo": "employeeCode",
		"puesto": "jobTitle", "horas_semanales": "weeklyHours",
	})
}

func presentFields(a map[string]any, names map[string]string) map[string]any {
	body := map[string]any{}
	for source, target := range names {
		if value, ok := a[source]; ok {
			body[target] = value
		}
	}
	return body
}

func (s *Service) leaveCalendar(ctx context.Context, p *principal, a map[string]any) (any, []string, error) {
	from, to := stringArg(a, "desde"), stringArg(a, "hasta")
	requests, err := s.doJSON(ctx, p.actor, http.MethodGet, collectionPath("leave_requests"), listQuery(a, nonEmpty("status = \"approved\"", filterDate("endDate", ">=", from), filterDate("startDate", "<=", to)), "startDate", "employee,leaveType"), nil)
	if err != nil {
		return nil, nil, err
	}
	holidays, err := s.doJSON(ctx, p.actor, http.MethodGet, collectionPath("public_holidays"), listQuery(a, nonEmpty(filterDate("date", ">=", from), filterDate("date", "<=", to)), "date", ""), nil)
	if err != nil {
		return nil, nil, err
	}
	blackouts, err := s.doJSON(ctx, p.actor, http.MethodGet, collectionPath("leave_blackout_periods"), listQuery(a, nonEmpty(filterDate("endDate", ">=", from), filterDate("startDate", "<=", to)), "startDate", "leaveType"), nil)
	return map[string]any{"ausencias": requests, "festivos": holidays, "periodos_bloqueados": blackouts}, nil, err
}

func (s *Service) timesheetReport(ctx context.Context, p *principal, a map[string]any) (any, []string, error) {
	from, err := requiredString(a, "desde", "desde")
	if err != nil {
		return nil, nil, err
	}
	to, err := requiredString(a, "hasta", "hasta")
	if err != nil {
		return nil, nil, err
	}
	employee := stringArg(a, "persona_id")
	if employee != "" {
		value, err := s.doJSON(ctx, p.actor, http.MethodGet, "/api/openjornada/timesheet", url.Values{
			"from": {from}, "to": {to}, "employee": {employee},
		}, nil)
		return value, []string{employee}, err
	}
	peopleValue, err := s.doJSON(ctx, p.actor, http.MethodGet, collectionPath("users"), url.Values{
		"page": {"1"}, "perPage": {"200"}, "sort": {"name"}, "filter": {`active = true`}, "fields": {"id,name,employeeCode"},
	}, nil)
	if err != nil {
		return nil, nil, err
	}
	peoplePage, _ := peopleValue.(map[string]any)
	people, _ := peoplePage["items"].([]any)
	items := make([]any, 0, len(people))
	ids := make([]string, 0, len(people))
	for _, item := range people {
		person, _ := item.(map[string]any)
		id, _ := person["id"].(string)
		if id == "" {
			continue
		}
		sheet, sheetErr := s.doJSON(ctx, p.actor, http.MethodGet, "/api/openjornada/timesheet", url.Values{
			"from": {from}, "to": {to}, "employee": {id},
		}, nil)
		if sheetErr != nil {
			return nil, ids, sheetErr
		}
		items = append(items, sheet)
		ids = append(ids, id)
	}
	return map[string]any{"from": from, "to": to, "items": items, "total": len(items)}, ids, nil
}

func (s *Service) uploadDocument(ctx context.Context, p *principal, a map[string]any) (any, []string, error) {
	encoded, err := requiredString(a, "contenido_base64", "contenido_base64")
	if err != nil {
		return nil, nil, err
	}
	content, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, nil, fmt.Errorf("contenido_base64 no es válido")
	}
	if len(content) == 0 || len(content) > 15<<20 {
		return nil, nil, fmt.Errorf("el archivo debe ocupar entre 1 byte y 15 MiB")
	}
	filename, err := requiredString(a, "nombre_archivo", "nombre_archivo")
	if err != nil || strings.ContainsAny(filename, `/\`) {
		return nil, nil, fmt.Errorf("el nombre de archivo no es válido")
	}
	fields := map[string]string{
		"organization": p.actor.GetString("organization"), "employee": stringArg(a, "persona_id"),
		"title": stringArg(a, "titulo"), "category": stringArg(a, "categoria"), "visibility": stringArg(a, "visibilidad"),
		"folder": stringArg(a, "directorio_id"), "acknowledgementRequired": fmt.Sprintf("%t", boolArg(a, "requiere_confirmacion", false)), "uploadedBy": p.actor.Id,
	}
	value, err := s.doMultipart(ctx, p.actor, http.MethodPost, collectionPath("employee_documents"), fields, "file", filename, content)
	return value, nonEmpty(stringArg(a, "persona_id"), stringArg(a, "directorio_id")), err
}

func publicActor(p *principal) map[string]any {
	return map[string]any{"id": p.actor.Id, "name": p.actor.GetString("name"), "email": p.actor.Email(), "role": p.actor.GetString("role")}
}

func fallbackString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func objectSchema(properties map[string]any, required []string) map[string]any {
	schema := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func stringProperty(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func booleanProperty(description string) map[string]any {
	return map[string]any{"type": "boolean", "description": description}
}

func integerProperty(description string) map[string]any {
	return map[string]any{"type": "integer", "description": description}
}

func numberProperty(description string) map[string]any {
	return map[string]any{"type": "number", "description": description}
}

func arrayProperty(description string) map[string]any {
	return map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": description}
}

func numberArrayProperty(description string) map[string]any {
	return map[string]any{"type": "array", "items": map[string]any{"type": "integer"}, "description": description}
}

func enumProperty(values ...string) map[string]any {
	return map[string]any{"type": "string", "enum": values}
}
