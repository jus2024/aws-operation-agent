import os
import uuid

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import (
    AgentCoreMemorySessionManager,
)

# AgentCore Memory の ID。`amplify/agent/resource.ts` が Runtime の環境変数として
# 設定する（同一スタック内の CfnMemory から synth 時に解決される）。中継 Lambda が
# 履歴復元（ListEvents）で使う環境変数と同じ名前に揃えている。
#
# 以前は AgentCore CLI が注入する `MEMORY_AWS_MCP_AGENTMEMORY_ID` を読んでいたが、
# CLI 管理をやめた際に値を設定する側がなくなり、Memory が無効（None）のまま
# 動作していた。
MEMORY_ID = os.getenv("AGENTCORE_MEMORY_ID")
REGION = os.getenv("AWS_REGION")

def get_memory_session_manager(session_id: str | None, actor_id: str) -> AgentCoreMemorySessionManager | None:
    if not MEMORY_ID:
        return None

    # AgentCoreMemoryConfig rejects None; OAuth/CUSTOM_JWT callers can reach us
    # without a runtime session header, so synthesize one when absent.
    session_id = session_id or uuid.uuid4().hex


    return AgentCoreMemorySessionManager(
        AgentCoreMemoryConfig(
            memory_id=MEMORY_ID,
            session_id=session_id,
            actor_id=actor_id,
        ),
        REGION
    )
