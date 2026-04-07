{{/*
Expand the name of the chart.
*/}}
{{- define "supercheck.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "supercheck.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "supercheck.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "supercheck.labels" -}}
helm.sh/chart: {{ include "supercheck.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: supercheck
{{- end }}

{{/*
Selector labels for app
*/}}
{{- define "supercheck.app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "supercheck.name" . }}-app
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Selector labels for worker
*/}}
{{- define "supercheck.worker.selectorLabels" -}}
app.kubernetes.io/name: {{ include "supercheck.name" . }}-worker
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Selector labels for postgres
*/}}
{{- define "supercheck.postgres.selectorLabels" -}}
app.kubernetes.io/name: {{ include "supercheck.name" . }}-postgres
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Selector labels for redis
*/}}
{{- define "supercheck.redis.selectorLabels" -}}
app.kubernetes.io/name: {{ include "supercheck.name" . }}-redis
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Selector labels for minio
*/}}
{{- define "supercheck.minio.selectorLabels" -}}
app.kubernetes.io/name: {{ include "supercheck.name" . }}-minio
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Database URL - constructed from components or overridden directly
*/}}
{{- define "supercheck.databaseUrl" -}}
{{- if .Values.config.database.url }}
{{- .Values.config.database.url }}
{{- else }}
{{- printf "postgresql://%s:%s@%s:%s/%s" .Values.config.database.user .Values.config.database.password .Values.config.database.host (toString .Values.config.database.port) .Values.config.database.name }}
{{- end }}
{{- end }}

{{/*
Redis URL - constructed from components or overridden directly
*/}}
{{- define "supercheck.redisUrl" -}}
{{- if .Values.config.redis.url }}
{{- .Values.config.redis.url }}
{{- else }}
{{- printf "redis://:%s@%s:%s" .Values.config.redis.password .Values.config.redis.host (toString .Values.config.redis.port) }}
{{- end }}
{{- end }}
