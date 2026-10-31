//! dreaming token 预算：预留、结算与账本读取。

use super::{db_err, now_ms, MemoryStore};
use crate::error::{AppError, AppResult};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

impl MemoryStore {
    /// 登记一笔 dreaming token 预留 —— **纯记账，不做日 token 总量准入**。
    ///
    /// 2026-10-06 用户裁决（与主动链同批口径：「一天最多几次」保留、「一天最多烧多少
    /// token」取消）：日 token 上限是资源账、不是门禁，预留一律接受并照记；批次容量
    /// 边界靠 `MAX_BATCHES_PER_RUN` 与单批预算。账的读取面仍是 `dreaming_budget`。
    /// 参数校验与幂等重放（同 reservationId 同昼同额的原样返回）保持原语义。
    pub fn reserve_dreaming_budget(
        &self,
        reservation_id: &str,
        local_date: &str,
        reserve: i64,
    ) -> AppResult<()> {
        if reservation_id.is_empty() || local_date.len() != 10 || reserve < 0 {
            return Err(AppError::Memory("dreaming 预算参数无效".into()));
        }
        let mut conn = self.lock()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;
        if let Some((saved_day,saved_amount))=tx.query_row("SELECT local_date,reserved_tokens FROM memory_dreaming_reservations WHERE reservation_id=?1",[reservation_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).optional().map_err(db_err)? {
            if saved_day!=local_date||saved_amount!=reserve{return Err(AppError::MemoryConflict);}
            tx.commit().map_err(db_err)?;return Ok(());
        }
        let now = now_ms();
        tx.execute("INSERT INTO memory_dreaming_budgets(local_date,updated_at) VALUES (?1,?2) ON CONFLICT(local_date) DO NOTHING",params![local_date,now]).map_err(db_err)?;
        tx.execute("UPDATE memory_dreaming_budgets SET reserved_tokens=reserved_tokens+?2,updated_at=?3 WHERE local_date=?1",params![local_date,reserve,now]).map_err(db_err)?;
        tx.execute("INSERT INTO memory_dreaming_reservations(reservation_id,local_date,reserved_tokens,used_tokens,status,created_at,updated_at) VALUES (?1,?2,?3,NULL,'reserved',?4,?4)",params![reservation_id,local_date,reserve,now]).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    pub fn settle_dreaming_budget(
        &self,
        reservation_id: &str,
        local_date: &str,
        reserved: i64,
        used: Option<i64>,
    ) -> AppResult<()> {
        if reservation_id.is_empty()
            || local_date.len() != 10
            || reserved < 0
            || used.is_some_and(|value| value < 0)
        {
            return Err(AppError::Memory("dreaming 结算参数无效".into()));
        }
        let mut conn = self.lock()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;
        if let Some(used) = used {
            let saved:Option<(String,i64,String,Option<i64>)>=tx.query_row("SELECT local_date,reserved_tokens,status,used_tokens FROM memory_dreaming_reservations WHERE reservation_id=?1",[reservation_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(db_err)?;
            let Some((day, amount, status, old_used)) = saved else {
                return Err(AppError::MemoryConflict);
            };
            if day != local_date || amount != reserved {
                return Err(AppError::MemoryConflict);
            }
            if status == "settled" {
                if old_used == Some(used) {
                    tx.commit().map_err(db_err)?;
                    return Ok(());
                }
                return Err(AppError::MemoryConflict);
            }
            tx.execute("UPDATE memory_dreaming_budgets SET reserved_tokens=MAX(0,reserved_tokens-?2),used_tokens=used_tokens+?3,updated_at=?4 WHERE local_date=?1",params![local_date,reserved,used,now_ms()]).map_err(db_err)?;
            tx.execute("UPDATE memory_dreaming_reservations SET status='settled',used_tokens=?2,updated_at=?3 WHERE reservation_id=?1",params![reservation_id,used,now_ms()]).map_err(db_err)?;
        }
        // Unknown usage intentionally keeps its reservation across process restarts.
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    pub fn dreaming_budget(&self, local_date: &str) -> AppResult<Value> {
        let conn = self.lock()?;
        let row:Option<(i64,i64)>=conn.query_row("SELECT reserved_tokens,used_tokens FROM memory_dreaming_budgets WHERE local_date=?1",[local_date],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_err)?;
        let (reserved, used) = row.unwrap_or((0, 0));
        Ok(json!({"localDate":local_date,"reservedTokens":reserved,"usedTokens":used}))
    }
}
