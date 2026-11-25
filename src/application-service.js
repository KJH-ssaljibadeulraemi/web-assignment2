import { AppError, missing, forbidden, invalidState } from './errors.js';

// 과제 2 구현: 신청·대기 취소·직접 승인·승인 취소(자동 승급)와 변경 이력.
// 모든 변경 요청은 inTransaction() 안에서 "최신 상태 조회 → 규칙 검사 → 상태 저장 → 이력 저장"을
// 한 번에 수행합니다. 도중에 검사 거부(AppError)나 저장 오류가 나면 ROLLBACK 하므로
// 상태와 이력이 일부만 남지 않습니다(R7 원자성, R8 최신 상태).

const alreadyApplied = () => new AppError(409,'ALREADY_APPLIED','이미 이 행사에 신청한 기록이 있습니다.');
const capacityFull = () => new AppError(409,'CAPACITY_FULL','정원이 가득 차 승인할 수 없습니다.');

// SQLite UNIQUE(event_id,user_id) 위반인지 판별 (최종 중복 방어를 409로 변환)
function isUniqueViolation(e) {
  return typeof e?.message === 'string' && e.message.includes('UNIQUE constraint failed: applications');
}

export function createApplicationService(repo) {
  const db = repo.db;

  // 트랜잭션 경계: BEGIN IMMEDIATE로 시작해 쓰기 잠금을 먼저 잡고,
  // 콜백이 정상 반환하면 COMMIT, 예외가 나면 ROLLBACK 후 예외를 다시 던집니다.
  function inTransaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 이미 롤백된 경우 무시 */ }
      throw e;
    }
  }

  // 행사 담당 운영자인지 확인 (R1)
  function isManagerOf(actor, event) {
    return actor.role === 'MANAGER' && event.managerId === actor.id;
  }

  return {
    // TODO-01 신청: 행사 존재 → 학생 역할 → 중복 → PENDING 저장 + APPLY 이력
    apply(actor, eventId) {
      return inTransaction(() => {
        const event = repo.event(eventId);
        if (!event) throw missing('행사');
        if (actor.role !== 'STUDENT') throw forbidden();
        // CANCELLED·REVOKED를 포함해 상태와 관계없이 기존 신청이 있으면 중복 (R2)
        if (repo.existing(eventId, actor.id)) throw alreadyApplied();
        let created;
        try {
          created = repo.insert(eventId, actor.id);
        } catch (e) {
          if (isUniqueViolation(e)) throw alreadyApplied();
          throw e;
        }
        repo.addHistory({ applicationId: created.id, actorId: actor.id, action: 'APPLY', fromStatus: null, toStatus: 'PENDING' });
        return created;
      });
    },

    // TODO-02 대기 취소: 신청 존재 → 본인 → PENDING → CANCELLED + CANCEL 이력 (자동 승급 없음)
    cancel(actor, applicationId) {
      return inTransaction(() => {
        const app = repo.application(applicationId);
        if (!app) throw missing('신청');
        if (actor.role !== 'STUDENT' || app.userId !== actor.id) throw forbidden();
        if (app.status !== 'PENDING') throw invalidState();
        const updated = repo.setStatus(app.id, 'CANCELLED');
        repo.addHistory({ applicationId: app.id, actorId: actor.id, action: 'CANCEL', fromStatus: 'PENDING', toStatus: 'CANCELLED' });
        return updated;
      });
    },

    // TODO-03 직접 승인: 신청 존재 → 담당자 → PENDING → 정원 → APPROVED + APPROVE 이력
    approve(actor, applicationId) {
      return inTransaction(() => {
        const app = repo.application(applicationId);
        if (!app) throw missing('신청');
        const event = repo.event(app.eventId);
        if (!isManagerOf(actor, event)) throw forbidden();
        if (app.status !== 'PENDING') throw invalidState();
        // APPROVED 수만 정원에 포함 (R4)
        if (repo.approvedCount(event.id) >= event.capacity) throw capacityFull();
        const updated = repo.setStatus(app.id, 'APPROVED');
        repo.addHistory({ applicationId: app.id, actorId: actor.id, action: 'APPROVE', fromStatus: 'PENDING', toStatus: 'APPROVED' });
        return updated;
      });
    },

    // TODO-04 승인 취소: 신청 존재 → 담당자 → APPROVED → REVOKED + REVOKE 이력
    //   → 같은 행사 PENDING 중 created_at ASC, id ASC 첫 1건 → APPROVED + AUTO_APPROVE 이력(원인 = REVOKE 이력 ID)
    //   신청 2건 + 이력 2건을 한 트랜잭션으로 처리합니다.
    revoke(actor, applicationId, reason) {
      return inTransaction(() => {
        const app = repo.application(applicationId);
        if (!app) throw missing('신청');
        const event = repo.event(app.eventId);
        if (!isManagerOf(actor, event)) throw forbidden();
        if (app.status !== 'APPROVED') throw invalidState();

        const revoked = repo.setStatus(app.id, 'REVOKED');
        const revokeHistoryId = repo.addHistory({
          applicationId: app.id, actorId: actor.id, action: 'REVOKE',
          fromStatus: 'APPROVED', toStatus: 'REVOKED', reason
        });

        // 빈자리 한 개에 대해 최대 한 명만 승급 (R5)
        let promoted = null;
        const next = repo.nextPending(event.id);
        if (next) {
          promoted = repo.setStatus(next.id, 'APPROVED');
          repo.addHistory({
            applicationId: next.id, actorId: actor.id, action: 'AUTO_APPROVE',
            fromStatus: 'PENDING', toStatus: 'APPROVED', causeHistoryId: revokeHistoryId
          });
        }
        return { revoked, promoted };
      });
    }
  };
}