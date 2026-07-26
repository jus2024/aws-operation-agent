"""Bedrock model loading for the AWS MCP Agent.

The agent processes both text-only and multimodal (text + inline base64 image)
AG-UI messages with a **single vision-capable multimodal model** via the
Bedrock Converse API (Strands ``BedrockModel``). AG-UI ``ImageInputContent``
blocks are converted to Strands Converse image content blocks by
``ag_ui_strands`` (see ``ag_ui_strands.utils.convert_agui_content_to_strands``);
this module only needs to guarantee that the configured model is
Converse-capable and vision-capable so those image blocks are actually
understood. There is **no per-input model routing** -- the same model handles
text-only and text+image turns (routing to a cheaper text-only model is a
possible future cost optimization only).

Configuration
-------------
The model ID is **configurable via the ``BEDROCK_MODEL_ID`` environment
variable** and is never hardcoded at the call site. When unset, a
region-appropriate cross-region inference profile for the default model
(Claude Sonnet 5, vision + Converse capable) is resolved from ``AWS_REGION`` /
``AWS_DEFAULT_REGION``.

Default model: Claude Sonnet 5
------------------------------
Base model ID ``anthropic.claude-sonnet-5`` requires a cross-region inference
profile for on-demand invocation. Only ``us.*`` and ``global.*`` inference
profiles exist for this model (verified via Bedrock ListInferenceProfiles);
there are no ``jp.`` / ``au.`` / ``apac.`` / ``eu.`` sonnet-5 profiles, so the
geo prefix is derived from the runtime region as just two cases:

* ``us-*``                -> ``us.anthropic.claude-sonnet-5``
* everything else / unknown -> ``global.anthropic.claude-sonnet-5``

(``eu-*``, ``ap-*``, unknown, empty, and ``None`` all map to ``global``.)

Verified (us-west-2 smoke test, task 11.6): ``anthropic.claude-sonnet-5`` is
available and accepted by the Converse API, and reports input modalities
``["TEXT", "IMAGE"]`` (vision-capable). The near-generation Converse-capable
fallback ``anthropic.claude-sonnet-4-6`` is exposed as ``FALLBACK_MODEL_ID``
for regions/accounts where Sonnet 5 is not (yet) accepted -- set
``BEDROCK_MODEL_ID`` to it (or a region-prefixed profile of it) in that case.

Any model configured via ``BEDROCK_MODEL_ID`` MUST be vision-capable; a
text-only model would fail on image requests.

Requirements: 9.7, 8.4
"""

from __future__ import annotations

import logging
import os

from strands.models.bedrock import BedrockModel

logger = logging.getLogger(__name__)

#: Environment variable used to override the Bedrock model ID (never hardcoded).
BEDROCK_MODEL_ID_ENV = "BEDROCK_MODEL_ID"

#: Base ID of the default model (Claude Sonnet 5). Vision + Converse capable.
#: Requires a cross-region inference profile prefix for on-demand invocation.
DEFAULT_MODEL_BASE_ID = "anthropic.claude-sonnet-5"

#: Near-generation Converse-capable, vision-capable fallback. Use by setting
#: ``BEDROCK_MODEL_ID`` when Sonnet 5 is not accepted in the target region.
FALLBACK_MODEL_ID = "anthropic.claude-sonnet-4-6"

#: Geo prefix used when the region cannot be mapped to a specific profile.
_GLOBAL_PREFIX = "global"


def resolve_geo_prefix(region: str | None) -> str:
    """Map an AWS region to its Bedrock cross-region inference profile prefix.

    Pure, total function (never raises). The default model
    (``anthropic.claude-sonnet-5``) only has ``us.*`` and ``global.*``
    inference profiles (verified via Bedrock ListInferenceProfiles), so this
    returns just ``us`` or ``global``:

    * ``us-*``                  -> ``us``
    * everything else / unknown -> ``global``

    An ``eu-*`` / ``ap-*`` / unknown / empty / ``None`` region all fall back to
    ``global`` (the global inference profile is broadly available).
    """
    if region and region.strip().lower().startswith("us-"):
        return "us"
    return _GLOBAL_PREFIX


def resolve_model_id(override: str | None, region: str | None) -> str:
    """Resolve the effective Bedrock model ID (pure, total function).

    * If ``override`` (the ``BEDROCK_MODEL_ID`` value) is a non-empty string,
      it wins verbatim -- the operator is responsible for it being
      vision-capable and Converse-capable.
    * Otherwise the region-appropriate cross-region inference profile for the
      default model (Claude Sonnet 5) is returned: ``us.anthropic.claude-sonnet-5``
      for ``us-*`` regions, ``global.anthropic.claude-sonnet-5`` for everything
      else (``eu-*`` / ``ap-*`` / unknown / ``None``).
    """
    if override and override.strip():
        return override.strip()
    return f"{resolve_geo_prefix(region)}.{DEFAULT_MODEL_BASE_ID}"


def load_model() -> BedrockModel:
    """Build the Bedrock Converse model client using IAM credentials.

    The model ID comes from ``BEDROCK_MODEL_ID`` when set, otherwise a
    region-resolved Claude Sonnet 5 inference profile. The returned
    ``BedrockModel`` is used for both text-only and multimodal (text + image)
    turns without any per-input routing.
    """
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    override = os.environ.get(BEDROCK_MODEL_ID_ENV)
    model_id = resolve_model_id(override, region)
    logger.info(
        "model.load",
        extra={
            "model_id": model_id,
            "region": region,
            "source": "env" if (override and override.strip()) else "default",
        },
    )
    return BedrockModel(model_id=model_id)
