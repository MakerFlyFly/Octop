"""tests/integration/test_admin_providers.py — admin /api/admin/providers CRUD."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from octop.infra.agents.providers.codex_apply import (
    CODEX_MODELS,
    CODEX_PROVIDER_NAME,
    apply_codex_credentials,
    sync_refreshed_codex_api_key,
)
from octop.infra.agents.providers.codex_oauth import (
    CODEX_BASE_URL,
    CodexOAuthCredentials,
    build_codex_headers,
    load_codex_token,
)
from tests.support.app import octop_client
from tests.support.auth import auth_header, bootstrap_admin

_PROBE_MODELS = [
    {"id": "disabled-first", "name": "disabled-first", "enabled": False},
    {"id": "enabled-second", "name": "enabled-second", "enabled": True},
    {"id": "saved-third", "name": "saved-third", "enabled": True},
]

_CODEX_CREDENTIALS: CodexOAuthCredentials = {
    "access": "simulated-new-access",
    "refresh": "simulated-new-refresh",
    "expires": 9999999999999,
    "account_id": "simulated-new-account",
}


@pytest.mark.parametrize("preference", ["saved", "cleared", "missing", "invalid-json"])
@pytest.mark.parametrize("set_active", [False, True])
async def test_codex_reauthorization_preserves_test_preference(env, preference, set_active):
    c, srv, auth = env
    created = await c.post(
        "/api/admin/providers",
        headers=auth,
        json={
            "name": CODEX_PROVIDER_NAME,
            "kind": "openai",
            "base_url": "https://example.com/v1",
            "api_key": "simulated-old-access",
            "models": _PROBE_MODELS,
            "model": "gpt-5.5" if preference in {"saved", "cleared"} else None,
            "extra_json": json.dumps({"headers": {"chatgpt-account-id": "old-account"}}),
        },
    )
    assert created.status_code == 201
    provider_id = created.json()["id"]
    if preference == "cleared":
        cleared = await c.patch(
            f"/api/admin/providers/{provider_id}", headers=auth, json={"model": None}
        )
        assert cleared.status_code == 200
    elif preference == "invalid-json":
        srv.services.provider_repo.update(provider_id, extra_json="{invalid-json")
    srv.services.settings_repo.set_active_model("keep-provider", "keep-model")

    applied_id = apply_codex_credentials(
        srv.services, srv.services.paths, _CODEX_CREDENTIALS, set_active=set_active
    )

    assert applied_id == provider_id
    listed = await c.get("/api/admin/providers", headers=auth)
    assert listed.status_code == 200
    response = next(row for row in listed.json() if row["id"] == provider_id)
    expected_model = "gpt-5.5" if preference == "saved" else None
    assert response["model"] == expected_model
    row = srv.services.provider_repo.get(provider_id)
    assert row is not None
    assert row.api_key == _CODEX_CREDENTIALS["access"]
    assert row.base_url == CODEX_BASE_URL
    assert row.get_models() == CODEX_MODELS
    expected_extra = {"headers": build_codex_headers(_CODEX_CREDENTIALS["account_id"])}
    if expected_model:
        expected_extra["probe_model"] = expected_model
    assert json.loads(row.extra_json) == expected_extra
    assert load_codex_token(srv.services.paths) == _CODEX_CREDENTIALS
    assert srv.services.settings_repo.get_active_model() == (
        (CODEX_PROVIDER_NAME, "gpt-5.4") if set_active else ("keep-provider", "keep-model")
    )


@pytest.mark.parametrize("set_active", [False, True])
async def test_codex_first_authorization_keeps_automatic_test_preference(env, set_active):
    c, srv, auth = env
    assert srv.services.provider_repo.get_by_name(CODEX_PROVIDER_NAME) is None
    srv.services.settings_repo.set_active_model("keep-provider", "keep-model")
    provider_id = apply_codex_credentials(
        srv.services, srv.services.paths, _CODEX_CREDENTIALS, set_active=set_active
    )
    listed = await c.get("/api/admin/providers", headers=auth)
    assert listed.status_code == 200
    response = next(row for row in listed.json() if row["id"] == provider_id)
    assert response["model"] is None
    assert response["base_url"] == CODEX_BASE_URL
    row = srv.services.provider_repo.get(provider_id)
    assert row is not None
    assert row.api_key == _CODEX_CREDENTIALS["access"]
    assert row.get_models() == CODEX_MODELS
    assert json.loads(row.extra_json) == {
        "headers": build_codex_headers(_CODEX_CREDENTIALS["account_id"])
    }
    assert load_codex_token(srv.services.paths) == _CODEX_CREDENTIALS
    assert srv.services.settings_repo.get_active_model() == (
        (CODEX_PROVIDER_NAME, "gpt-5.4") if set_active else ("keep-provider", "keep-model")
    )


async def test_codex_token_refresh_preserves_test_preference_and_options(env):
    c, srv, auth = env
    created = await c.post(
        "/api/admin/providers",
        headers=auth,
        json={
            "name": CODEX_PROVIDER_NAME,
            "kind": "openai",
            "model": "gpt-5.5",
            "extra_json": json.dumps({"headers": {"X-Test": "kept"}, "custom": "kept"}),
            "stream_usage": False,
        },
    )
    assert created.status_code == 201
    provider_id = created.json()["id"]
    before = srv.services.provider_repo.get(provider_id)
    assert before is not None
    sync_refreshed_codex_api_key(srv.services, srv.services.paths, "simulated-refreshed-access")
    listed = await c.get("/api/admin/providers", headers=auth)
    assert listed.status_code == 200
    response = next(row for row in listed.json() if row["id"] == provider_id)
    assert response["model"] == "gpt-5.5"
    after = srv.services.provider_repo.get(provider_id)
    assert after is not None
    assert after.api_key == "simulated-refreshed-access"
    assert after.extra_json == before.extra_json


async def test_probe_model_round_trip_preserves_routing(env):
    c, srv, auth = env
    created = await c.post(
        "/api/admin/providers",
        headers=auth,
        json={
            "name": "probe-preference",
            "kind": "openai",
            "base_url": "https://example.com/v1",
            "api_key": "test-key",
            "models": _PROBE_MODELS,
            "model": " saved-third ",
            "extra_json": json.dumps({"headers": {"X-Test": "kept"}, "custom": "kept"}),
            "stream_usage": False,
        },
    )
    assert created.status_code == 201
    provider_id = created.json()["id"]
    assert created.json().get("model") == "saved-third"
    before = srv.services.provider_repo.get(provider_id)
    srv.services.settings_repo.set_active_model("probe-preference", "saved-third")
    preferred = await c.patch(
        "/api/preferences",
        headers=auth,
        json={"preferred_model": "probe-preference/saved-third"},
    )
    assert preferred.status_code == 200
    agent_defaults = [
        (row.agent_id, row.default_model, row.config_json)
        for row in srv.services.agent_repo.list_all()
    ]

    with patch.object(
        srv.app_runtime.agent_registry, "on_provider_changed", new=AsyncMock()
    ) as reload:
        updated = await c.patch(
            f"/api/admin/providers/{provider_id}",
            headers=auth,
            json={"model": "enabled-second"},
        )
        assert updated.status_code == 200
        assert updated.json()["model"] == "enabled-second"
        reload.assert_not_awaited()

    after = srv.services.provider_repo.get(provider_id)
    assert after.models_json == before.models_json
    assert after.api_key == before.api_key
    assert after.base_url == before.base_url
    assert json.loads(after.extra_json) == {
        "headers": {"X-Test": "kept"},
        "custom": "kept",
        "stream_usage": False,
        "probe_model": "enabled-second",
    }
    assert srv.services.settings_repo.get_active_model() == ("probe-preference", "saved-third")
    assert (await c.get("/api/preferences", headers=auth)).json()["preferred_model"] == (
        "probe-preference/saved-third"
    )
    assert [
        (row.agent_id, row.default_model, row.config_json)
        for row in srv.services.agent_repo.list_all()
    ] == agent_defaults
    for endpoint in ("/api/providers", "/api/admin/providers"):
        listed = await c.get(endpoint, headers=auth)
        assert listed.status_code == 200
        assert next(row for row in listed.json() if row["id"] == provider_id)["model"] == (
            "enabled-second"
        )


@pytest.mark.parametrize("reset_value", [None, "", "   "])
async def test_probe_model_omission_and_clear(env, reset_value):
    c, srv, auth = env
    created = await c.post(
        "/api/admin/providers",
        headers=auth,
        json={
            "name": "probe-reset",
            "kind": "openai",
            "api_key": "test-key",
            "models": _PROBE_MODELS,
            "model": "saved-third",
        },
    )
    provider_id = created.json()["id"]
    omitted = await c.patch(
        f"/api/admin/providers/{provider_id}", headers=auth, json={"note": "ops memo"}
    )
    assert omitted.status_code == 200
    assert omitted.json().get("model") == "saved-third"
    cleared = await c.patch(
        f"/api/admin/providers/{provider_id}", headers=auth, json={"model": reset_value}
    )
    assert cleared.status_code == 200
    assert cleared.json()["model"] is None
    assert "probe_model" not in json.loads(srv.services.provider_repo.get(provider_id).extra_json)
    fake = AsyncMock()
    with patch(
        "octop.infra.agents.providers.probe.build_probe_chat_model", return_value=fake
    ) as build:
        tested = await c.post(f"/api/admin/providers/{provider_id}/test", headers=auth)
    assert tested.status_code == 200
    assert tested.json()["ok"] is True
    assert build.call_args.kwargs["model_id"] == "enabled-second"


async def test_probe_model_survives_other_options_updates(env):
    c, srv, auth = env
    created = await c.post(
        "/api/admin/providers",
        headers=auth,
        json={
            "name": "probe-options",
            "kind": "openai",
            "models": _PROBE_MODELS,
            "model": "saved-third",
            "extra_json": json.dumps({"headers": {"X-Test": "old"}}),
            "stream_usage": False,
        },
    )
    provider_id = created.json()["id"]
    for payload in (
        {"stream_usage": True},
        {"extra_json": None},
        {"extra_json": json.dumps({"headers": {"X-Test": "new"}, "custom": 42})},
    ):
        updated = await c.patch(f"/api/admin/providers/{provider_id}", headers=auth, json=payload)
        assert updated.status_code == 200
        assert updated.json().get("model") == "saved-third"

    updated = await c.patch(
        f"/api/admin/providers/{provider_id}",
        headers=auth,
        json={"model": "enabled-second", "stream_usage": False},
    )
    assert updated.status_code == 200
    assert updated.json()["model"] == "enabled-second"
    assert updated.json()["stream_usage"] is False
    assert json.loads(srv.services.provider_repo.get(provider_id).extra_json) == {
        "headers": {"X-Test": "new"},
        "custom": 42,
        "stream_usage": False,
        "probe_model": "enabled-second",
    }
    updated = await c.patch(
        f"/api/admin/providers/{provider_id}",
        headers=auth,
        json={
            "model": None,
            "stream_usage": True,
            "extra_json": json.dumps({"headers": {"X-Test": "final"}}),
        },
    )
    assert updated.json()["model"] is None
    assert json.loads(srv.services.provider_repo.get(provider_id).extra_json) == {
        "headers": {"X-Test": "final"},
        "stream_usage": True,
    }
    assert srv.services.provider_repo.get(provider_id).get_models() == _PROBE_MODELS


async def test_probe_model_survives_server_restart(tmp_octop_home):
    async with octop_client(tmp_octop_home) as (c, _):
        await bootstrap_admin(c, tmp_octop_home)
        auth = await auth_header(c)
        created = await c.post(
            "/api/admin/providers",
            headers=auth,
            json={
                "name": "probe-restart",
                "kind": "openai",
                "api_key": "test-key",
                "models": _PROBE_MODELS,
                "model": "saved-third",
            },
        )
        assert created.status_code == 201
        provider_id = created.json()["id"]
    async with octop_client(tmp_octop_home) as (c, srv):
        auth = await auth_header(c)
        listed = (await c.get("/api/admin/providers", headers=auth)).json()
        assert next(row for row in listed if row["id"] == provider_id).get("model") == "saved-third"
        assert srv.services.provider_repo.get(provider_id).get_models() == _PROBE_MODELS
        fake = AsyncMock()
        with patch(
            "octop.infra.agents.providers.probe.build_probe_chat_model", return_value=fake
        ) as build:
            tested = await c.post(f"/api/admin/providers/{provider_id}/test", headers=auth)
            assert tested.json()["ok"] is True
            assert build.call_args.kwargs["model_id"] == "saved-third"
            tested = await c.post(
                f"/api/admin/providers/{provider_id}/test",
                headers=auth,
                json={"model_id": "disabled-first"},
            )
            assert tested.json()["ok"] is True
            assert build.call_args.kwargs["model_id"] == "disabled-first"


async def test_admin_create_and_list(env):
    c, _, auth = env
    r = await c.post(
        "/api/admin/providers",
        headers=auth,
        json={"name": "shared-gpt", "kind": "openai", "api_key": "sk-test"},
    )
    assert r.status_code == 201
    created = r.json()
    assert created["name"] == "shared-gpt"
    assert "user_id" not in created

    r = await c.get("/api/admin/providers", headers=auth)
    assert r.status_code == 200
    names = [p["name"] for p in r.json()]
    assert "shared-gpt" in names


async def test_admin_only_admin_can_create(env):
    c, _, admin_auth = env
    await c.post(
        "/api/users",
        headers=admin_auth,
        json={"username": "regular", "password": "TestPass12", "role": "user"},
    )
    tok = (
        await c.post("/api/auth/login", json={"username": "regular", "password": "TestPass12"})
    ).json()["access_token"]
    user_auth = {"Authorization": f"Bearer {tok}"}

    r = await c.post(
        "/api/admin/providers",
        headers=user_auth,
        json={"name": "should-fail", "kind": "openai"},
    )
    assert r.status_code == 403


async def test_admin_delete(env):
    c, _, auth = env
    r = await c.post(
        "/api/admin/providers",
        headers=auth,
        json={"name": "to-delete", "kind": "openai"},
    )
    assert r.status_code == 201
    pid = r.json()["id"]

    r = await c.delete(f"/api/admin/providers/{pid}", headers=auth)
    assert r.status_code in (200, 204)

    r = await c.get("/api/admin/providers", headers=auth)
    assert r.status_code == 200
    ids = [p["id"] for p in r.json()]
    assert pid not in ids
