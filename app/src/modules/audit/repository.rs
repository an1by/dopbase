use super::model::AuditEvent;
use sqlx::{QueryBuilder, Sqlite, SqlitePool};

/// Which events a reader may see.
pub enum Visibility<'a> {
  All,
  /// Instance events, the reader's own, and events on `projects` apart
  /// from those of the `hidden` environments in them, which the reader
  /// can't reach. Events of an environment deleted since still show.
  Scoped {
    actor_id: &'a str,
    projects: Vec<String>,
    hidden: Vec<String>,
  },
  /// Only the reader's own actions.
  Own {
    actor_id: &'a str,
  },
}

/// The filters a reader picked. Each is left out of the SQL when unset, so
/// the matching index can do the work.
#[derive(Default)]
pub struct Filters<'a> {
  pub action: Option<&'a str>,
  pub project: Option<&'a str>,
  pub environment: Option<&'a str>,
  pub actor: Option<&'a str>,
}

/// Newest first, strictly before the `(created_at, id)` cursor when given.
pub async fn list(
  pool: &SqlitePool,
  visibility: &Visibility<'_>,
  before: Option<(&str, &str)>,
  limit: u32,
  filters: Filters<'_>,
) -> Result<Vec<AuditEvent>, sqlx::Error> {
  let mut query: QueryBuilder<Sqlite> = QueryBuilder::new(
    "SELECT id, actor_type, actor_id, actor_label, action, project_id, environment_id, resource_type, resource_id, ip_address, metadata, created_at, seq, prev_hash, record_hash FROM audit_events WHERE TRUE",
  );
  if let Some((time, id)) = before {
    query.push(" AND (created_at < ");
    query.push_bind(time.to_owned());
    query.push(" OR (created_at = ");
    query.push_bind(time.to_owned());
    query.push(" AND id < ");
    query.push_bind(id.to_owned());
    query.push("))");
  }
  if let Some(action) = filters.action {
    query.push(" AND action = ").push_bind(action.to_owned());
  }
  if let Some(project) = filters.project {
    query
      .push(" AND project_id = ")
      .push_bind(project.to_owned());
  }
  if let Some(environment) = filters.environment {
    query
      .push(" AND environment_id = ")
      .push_bind(environment.to_owned());
  }
  if let Some(actor) = filters.actor {
    query.push(" AND (actor_id = ");
    query.push_bind(actor.to_owned());
    query.push(" OR actor_label = ");
    query.push_bind(actor.to_owned());
    query.push(")");
  }
  match visibility {
    Visibility::All => {}
    Visibility::Own { actor_id } => {
      query
        .push(" AND actor_id = ")
        .push_bind((*actor_id).to_owned());
    }
    Visibility::Scoped {
      actor_id,
      projects,
      hidden,
    } => {
      query.push(" AND (project_id IS NULL OR actor_id = ");
      query.push_bind((*actor_id).to_owned());
      if !projects.is_empty() {
        query.push(" OR (project_id IN (");
        push_list(&mut query, projects);
        query.push(")");
        if !hidden.is_empty() {
          query.push(" AND (environment_id IS NULL OR environment_id NOT IN (");
          push_list(&mut query, hidden);
          query.push("))");
        }
        query.push(")");
      }
      query.push(")");
    }
  }
  query.push(" ORDER BY created_at DESC, id DESC LIMIT ");
  query.push_bind(i64::from(limit));
  query.build_query_as().fetch_all(pool).await
}

fn push_list(
  query: &mut QueryBuilder<'_, Sqlite>,
  values: &[String],
) {
  let mut list = query.separated(", ");
  for value in values {
    list.push_bind(value.clone());
  }
}
