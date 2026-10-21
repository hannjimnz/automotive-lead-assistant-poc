CREATE TABLE public.lead_perfil_chatbot (
  lead_id uuid PRIMARY KEY
    REFERENCES public.leads (id) ON DELETE CASCADE,
  temporalidad text,
  intencion text,
  capacidad_declarada text,
  presupuesto numeric,
  forma_pago text,
  enganche numeric,
  vehiculo_a_cuenta boolean,
  marca_vehiculo_a_cuenta text,
  modelo_vehiculo_a_cuenta text,
  anio_vehiculo_a_cuenta integer,
  sucursal text,
  accion_solicitada text,
  dudas text,
  siguiente_paso_sistema text NOT NULL,
  estados_recopilacion jsonb NOT NULL,
  version_actualizacion bigint NOT NULL,
  snapshot_hash text NOT NULL,
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_perfil_chatbot_temporalidad_check
    CHECK (temporalidad IS NULL OR temporalidad IN ('0-30', '31-90', '90+', 'undefined')),
  CONSTRAINT lead_perfil_chatbot_intencion_check
    CHECK (intencion IS NULL OR intencion IN ('advance', 'compare', 'explore')),
  CONSTRAINT lead_perfil_chatbot_capacidad_check
    CHECK (capacidad_declarada IS NULL OR capacidad_declarada IN ('ready', 'review', 'unavailable')),
  CONSTRAINT lead_perfil_chatbot_presupuesto_check
    CHECK (presupuesto IS NULL OR presupuesto BETWEEN 0 AND 100000000),
  CONSTRAINT lead_perfil_chatbot_forma_pago_check
    CHECK (forma_pago IS NULL OR forma_pago IN ('cash', 'credit')),
  CONSTRAINT lead_perfil_chatbot_enganche_check
    CHECK (enganche IS NULL OR enganche BETWEEN 0 AND 100000000),
  CONSTRAINT lead_perfil_chatbot_vehiculo_marca_check
    CHECK (marca_vehiculo_a_cuenta IS NULL OR length(marca_vehiculo_a_cuenta) <= 100),
  CONSTRAINT lead_perfil_chatbot_vehiculo_modelo_check
    CHECK (modelo_vehiculo_a_cuenta IS NULL OR length(modelo_vehiculo_a_cuenta) <= 100),
  CONSTRAINT lead_perfil_chatbot_anio_check
    CHECK (anio_vehiculo_a_cuenta IS NULL OR anio_vehiculo_a_cuenta BETWEEN 1900 AND 2100),
  CONSTRAINT lead_perfil_chatbot_sucursal_check
    CHECK (sucursal IS NULL OR length(sucursal) <= 100),
  CONSTRAINT lead_perfil_chatbot_accion_check
    CHECK (accion_solicitada IS NULL OR accion_solicitada IN ('appointment', 'test_drive', 'call', 'later')),
  CONSTRAINT lead_perfil_chatbot_dudas_check
    CHECK (dudas IS NULL OR length(dudas) <= 2000),
  CONSTRAINT lead_perfil_chatbot_next_step_check
    CHECK (siguiente_paso_sistema IN (
      'confirm_proposed_data',
      'collect_name', 'collect_phone', 'collect_email', 'collect_vehicleId',
      'collect_timeframe', 'collect_intention', 'collect_capacity', 'collect_budget',
      'collect_payment', 'collect_downPayment', 'collect_tradeIn', 'collect_tradeInBrand',
      'collect_tradeInModel', 'collect_tradeInYear', 'collect_branch', 'collect_action',
      'request_recorded', 'review_with_advisor'
    )),
  CONSTRAINT lead_perfil_chatbot_estados_objeto_check
    CHECK (jsonb_typeof(estados_recopilacion) = 'object'),
  CONSTRAINT lead_perfil_chatbot_version_check
    CHECK (version_actualizacion > 0),
  CONSTRAINT lead_perfil_chatbot_hash_check
    CHECK (snapshot_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE public.lead_perfil_chatbot ENABLE ROW LEVEL SECURITY;
