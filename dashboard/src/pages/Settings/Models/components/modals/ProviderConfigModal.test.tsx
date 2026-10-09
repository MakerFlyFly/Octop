import { useState } from "react";
import { App } from "antd";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { request } from "../../../../../api/request";
import { onnxModelApi } from "../../../../../api/modules/onnxModel";
import { watchOnnxDownload } from "../../../../../api/modules/onnxDownloadWatcher";
import type { ProviderRow } from "../../useProviders";
import type { LocalModelDownloadControl } from "./ModelListEditor";
import { ProviderConfigModal } from "./ProviderConfigModal";

vi.mock("../../../../../api/request", () => ({ request: vi.fn() }));
vi.mock("./ModelListEditor", () => ({
  ModelListEditor: ({
    localDownload,
  }: {
    localDownload?: LocalModelDownloadControl;
  }) =>
    localDownload ? (
      <button onClick={() => localDownload.onDownload("saved-third")}>
        Download saved-third
      </button>
    ) : null,
}));
vi.mock("../../../../../api/modules/onnxModel", () => ({
  onnxModelApi: {
    getStatus: vi.fn(),
    getCatalog: vi.fn(),
    getModelMeta: vi.fn(),
    download: vi.fn(),
    updateConfig: vi.fn(),
  },
}));
vi.mock("../../../../../api/modules/onnxDownloadWatcher", () => ({
  watchOnnxDownload: vi.fn(),
  setOnnxDownloadProgressHandler: vi.fn(),
}));

const getComputedStyle = window.getComputedStyle;

const provider: ProviderRow & { model: string | null } = {
  id: 12,
  name: "custom",
  kind: "openai",
  base_url: "https://example.com/v1",
  api_key: "test-key",
  model: "saved-third",
  models: [
    { id: "disabled-first", name: "disabled-first", enabled: false },
    { id: "enabled-second", name: "enabled-second", enabled: true },
    { id: "saved-third", name: "saved-third", enabled: true },
  ],
  note: null,
  enabled: true,
  stream_usage: false,
};

function renderModal(initial: ProviderRow) {
  const onSaved = vi.fn();
  const content = (current: ProviderRow, open = true) => (
    <App>
      <ProviderConfigModal
        provider={current}
        open={open}
        apiPrefix="/admin/providers"
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    </App>
  );
  const view = render(content(initial));
  return {
    onSaved,
    unmount: view.unmount,
    refresh: (current: ProviderRow, open = true) =>
      view.rerender(content(current, open)),
  };
}

async function startPendingDownload() {
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Download saved-third" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "models.localDownloadModel" }),
  );
  await waitFor(() => expect(watchOnnxDownload).toHaveBeenCalledTimes(1));

  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const response = new Promise<unknown>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  vi.mocked(request).mockReturnValueOnce(response);
  let completion: void | Promise<void> = undefined;
  await act(async () => {
    completion = vi.mocked(watchOnnxDownload).mock.calls[0][0].onTerminal({
      status: "done",
      progress: 1,
      model_name: "saved-third",
    });
    await Promise.resolve();
  });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  const [url, options] = vi.mocked(request).mock.calls[0];
  const payload = JSON.parse(options!.body as string);
  expect(url).toBe("/admin/providers/12");
  expect(payload.model).toBe("saved-third");

  return {
    models: payload.models,
    finish: async (error?: Error) => {
      await act(async () => {
        if (error) reject(error);
        else resolve({ ok: true });
        await completion;
      });
    },
  };
}

const localProvider: ProviderRow = {
  ...provider,
  name: "onnx",
  api_key: "onnx",
  base_url: null,
  model: null,
  models: [
    { id: "saved-third", name: "saved-third", enabled: false },
    { id: "enabled-second", name: "enabled-second", enabled: true },
  ],
};

async function saveNote() {
  const user = userEvent.setup();
  await user.type(
    screen.getByRole("textbox", { name: "models.noteLabel" }),
    "memo",
  );
  await user.click(screen.getByRole("button", { name: "common.save" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  return JSON.parse(vi.mocked(request).mock.calls[0][1]!.body as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom cannot measure the pseudo-element used by the drawer's scrollbar.
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    getComputedStyle.call(window, element),
  );
  vi.mocked(request).mockResolvedValue({ ok: true });
  const status = {
    enabled: true,
    model: "",
    ready: false,
    downloaded: false,
    cache_dir: "",
    download: { status: "idle" as const, progress: 0, model_name: "" },
    local_models: ["saved-third", "enabled-second"],
    presets: [],
  };
  vi.mocked(onnxModelApi.getStatus).mockResolvedValue(status);
  vi.mocked(onnxModelApi.getCatalog).mockResolvedValue([]);
  vi.mocked(onnxModelApi.getModelMeta).mockResolvedValue({
    id: "saved-third",
    size_gb: 0.1,
  });
  vi.mocked(onnxModelApi.download).mockResolvedValue({
    status: "downloading",
    progress: 0,
    model_name: "saved-third",
  });
  vi.mocked(onnxModelApi.updateConfig).mockResolvedValue(status);
});

afterEach(() => {
  vi.mocked(window.getComputedStyle).mockRestore();
});

it("loads, saves and reopens the test preference without rewriting the model list", async () => {
  function Harness() {
    const [current, setCurrent] = useState(provider);
    const [open, setOpen] = useState(true);
    return (
      <App>
        <button onClick={() => setOpen(true)}>Reopen provider</button>
        <ProviderConfigModal
          provider={current}
          open={open}
          apiPrefix="/admin/providers"
          onClose={() => setOpen(false)}
          onSaved={() => setCurrent({ ...current, model: "enabled-second" })}
        />
      </App>
    );
  }
  const user = userEvent.setup();
  render(<Harness />);
  await screen.findByTitle("saved-third");
  await user.click(
    screen.getByRole("combobox", { name: "models.defaultModelLabel" }),
  );
  await user.click(await screen.findByTitle("enabled-second"));
  await user.click(screen.getByRole("button", { name: "common.save" }));
  await waitFor(() => expect(request).toHaveBeenCalled());
  const [url, options] = vi.mocked(request).mock.calls[0];
  expect(url).toBe("/admin/providers/12");
  expect(options!.method).toBe("PATCH");
  expect(JSON.parse(options!.body as string)).toEqual({
    model: "enabled-second",
  });
  await waitFor(() =>
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument(),
  );
  await user.click(screen.getByRole("button", { name: "Reopen provider" }));
  await screen.findByTitle("enabled-second");
});

it("submits null when the saved test preference is cleared", async () => {
  const user = userEvent.setup();
  render(
    <App>
      <ProviderConfigModal
        provider={provider}
        open
        apiPrefix="/admin/providers"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    </App>,
  );
  await screen.findByTitle("saved-third");
  // rc-select marks its visible clear control aria-hidden.
  await user.click(document.querySelector(".ant-select-clear")!);
  await user.click(screen.getByRole("button", { name: "common.save" }));
  await waitFor(() => expect(request).toHaveBeenCalled());
  const [, options] = vi.mocked(request).mock.calls[0];
  expect(JSON.parse(options!.body as string)).toEqual({ model: null });
});

it("keeps automatic selection blank and tests the first enabled model", async () => {
  const user = userEvent.setup();
  render(
    <App>
      <ProviderConfigModal
        provider={{ ...provider, model: null }}
        open
        apiPrefix="/admin/providers"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    </App>,
  );
  await screen.findByRole("combobox", { name: "models.defaultModelLabel" });
  expect(screen.queryByTitle("disabled-first")).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "models.testConnection" }),
  );
  await waitFor(() => expect(request).toHaveBeenCalled());
  const [url, options] = vi.mocked(request).mock.calls[0];
  expect(url).toBe("/admin/providers/12/test");
  expect(JSON.parse(options!.body as string)).toEqual({
    model_id: "enabled-second",
    embedding: false,
  });
});

it.each(["saved-third", null])(
  "omits an untouched test preference after a background refresh (initial %s)",
  async (initial) => {
    const view = renderModal({ ...provider, model: initial });
    await screen.findByRole("combobox", { name: "models.defaultModelLabel" });
    view.refresh({ ...provider, model: "enabled-second" });
    if (initial) expect(screen.getByTitle(initial)).toBeInTheDocument();
    expect(await saveNote()).toEqual({ note: "memo" });
  },
);

it.each(["disabled-first", null])(
  "submits an explicit test preference edit after a background refresh (%s)",
  async (selected) => {
    const user = userEvent.setup();
    const view = renderModal(provider);
    await screen.findByTitle("saved-third");
    view.refresh({ ...provider, model: "enabled-second" });
    if (selected) {
      await user.click(
        screen.getByRole("combobox", { name: "models.defaultModelLabel" }),
      );
      await user.click(await screen.findByTitle(selected));
    } else {
      await user.click(document.querySelector(".ant-select-clear")!);
    }
    expect(await saveNote()).toEqual({ note: "memo", model: selected });
  },
);

it("omits a test preference edit reverted to the opening value", async () => {
  const user = userEvent.setup();
  const view = renderModal(provider);
  await screen.findByTitle("saved-third");
  view.refresh({ ...provider, model: "enabled-second" });
  await user.click(
    screen.getByRole("combobox", { name: "models.defaultModelLabel" }),
  );
  await user.click(await screen.findByTitle("disabled-first"));
  await user.click(
    screen.getByRole("combobox", { name: "models.defaultModelLabel" }),
  );
  await user.click(await screen.findByTitle("saved-third"));
  expect(await saveNote()).toEqual({ note: "memo" });
});

it.each(["reopen", "different-provider"])(
  "captures a new comparison value on %s",
  async (change) => {
    const view = renderModal(provider);
    await screen.findByTitle("saved-third");
    const next = {
      ...provider,
      id: change === "reopen" ? provider.id : 13,
      model: "enabled-second",
    };
    if (change === "reopen") view.refresh(next, false);
    view.refresh(next);
    await screen.findByTitle("enabled-second");
    view.refresh({ ...next, model: "disabled-first" });
    expect(await saveNote()).toEqual({ note: "memo" });
    expect(vi.mocked(request).mock.calls[0][0]).toBe(
      `/admin/providers/${next.id}`,
    );
  },
);

it("ignores whitespace around an unchanged free-text test preference", async () => {
  const user = userEvent.setup();
  renderModal({ ...provider, models: [] });
  const field = await screen.findByRole("textbox", {
    name: "models.defaultModelLabel",
  });
  await user.clear(field);
  await user.type(field, " saved-third ");
  expect(await saveNote()).toEqual({ note: "memo" });
});

it.each([true, false])(
  "uses the confirmed download save as the comparison value only on success (%s)",
  async (saveSucceeded) => {
    const user = userEvent.setup();
    const local = {
      ...provider,
      name: "onnx",
      api_key: "onnx",
      base_url: null,
      model: null,
      models: [{ id: "saved-third", name: "saved-third", enabled: false }],
    };
    const view = renderModal(local);
    await user.click(
      await screen.findByRole("button", { name: "Download saved-third" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "models.localDownloadModel" }),
    );
    await waitFor(() => expect(watchOnnxDownload).toHaveBeenCalledTimes(1));
    if (!saveSucceeded)
      vi.mocked(request).mockRejectedValueOnce(
        new Error("simulated save failure"),
      );
    await act(async () => {
      await vi.mocked(watchOnnxDownload).mock.calls[0][0].onTerminal({
        status: "done",
        progress: 1,
        model_name: "saved-third",
      });
    });
    expect(request).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(
      vi.mocked(request).mock.calls[0][1]!.body as string,
    );
    expect(saved.model).toBe("saved-third");
    if (saveSucceeded) {
      expect(view.onSaved).toHaveBeenCalledTimes(1);
      // A later refresh changes the persisted choice, while the open form stays put.
      view.refresh({ ...local, model: "enabled-second", models: saved.models });
    } else {
      expect(view.onSaved).not.toHaveBeenCalled();
    }
    vi.mocked(request).mockClear();
    expect(await saveNote()).toEqual(
      saveSucceeded
        ? { note: "memo" }
        : { note: "memo", model: "saved-third", models: saved.models },
    );
  },
);

it("omits an untouched model after reopening during a pending download save", async () => {
  const view = renderModal(localProvider);
  const pending = await startPendingDownload();
  const reopened = { ...localProvider, models: pending.models };
  view.refresh(reopened, false);
  view.refresh(reopened);
  await screen.findByRole("combobox", { name: "models.defaultModelLabel" });
  await pending.finish();
  expect(view.onSaved).toHaveBeenCalledTimes(1);
  expect(onnxModelApi.updateConfig).toHaveBeenCalledWith({
    enabled: true,
    model: "saved-third",
    download_if_missing: false,
  });
  view.refresh({ ...reopened, model: "saved-third" });
  vi.mocked(request).mockClear();
  expect(await saveNote()).toEqual({ note: "memo" });
});

it.each(["reopen", "switch", "switch-back"])(
  "keeps explicit model edits when an old download response arrives after %s",
  async (change) => {
    const user = userEvent.setup();
    const view = renderModal(localProvider);
    const pending = await startPendingDownload();
    const newer = {
      ...localProvider,
      model: "enabled-second",
      models: pending.models,
    };
    const other = { ...newer, id: 13 };
    if (change === "reopen") {
      view.refresh(newer, false);
      view.refresh(newer);
    } else {
      view.refresh(other);
      if (change === "switch-back") view.refresh(newer);
    }
    await screen.findByTitle("enabled-second");
    await user.click(
      screen.getByRole("combobox", { name: "models.defaultModelLabel" }),
    );
    await user.click(await screen.findByTitle("saved-third"));
    await pending.finish();
    expect(view.onSaved).toHaveBeenCalledTimes(1);
    expect(onnxModelApi.updateConfig).toHaveBeenCalledTimes(1);
    vi.mocked(request).mockClear();
    expect(await saveNote()).toEqual({ note: "memo", model: "saved-third" });
    expect(vi.mocked(request).mock.calls[0][0]).toBe(
      `/admin/providers/${change === "switch" ? 13 : 12}`,
    );
  },
);

it("keeps the current download save valid across an ordinary background refresh", async () => {
  const view = renderModal(localProvider);
  const pending = await startPendingDownload();
  view.refresh({
    ...localProvider,
    model: "enabled-second",
    models: pending.models,
  });
  await pending.finish();
  expect(view.onSaved).toHaveBeenCalledTimes(1);
  vi.mocked(request).mockClear();
  expect(await saveNote()).toEqual({ note: "memo" });
});

it("preserves an explicit clear while the current download save is pending", async () => {
  const user = userEvent.setup();
  const view = renderModal(localProvider);
  const pending = await startPendingDownload();
  await user.click(document.querySelector(".ant-select-clear")!);
  await pending.finish();
  view.refresh({
    ...localProvider,
    model: "saved-third",
    models: pending.models,
  });
  vi.mocked(request).mockClear();
  expect(await saveNote()).toEqual({ note: "memo", model: null });
});

it.each(["closed", "unmounted"])(
  "completes background activation and refresh when the editor is %s",
  async (state) => {
    const view = renderModal(localProvider);
    const pending = await startPendingDownload();
    if (state === "closed") view.refresh(localProvider, false);
    else view.unmount();
    await pending.finish();
    expect(request).toHaveBeenCalledTimes(1);
    expect(onnxModelApi.updateConfig).toHaveBeenCalledWith({
      enabled: true,
      model: "saved-third",
      download_if_missing: false,
    });
    expect(view.onSaved).toHaveBeenCalledTimes(1);
  },
);

it("keeps reopened model edits when an old download save fails", async () => {
  const user = userEvent.setup();
  const view = renderModal(localProvider);
  const pending = await startPendingDownload();
  const reopened = { ...localProvider, model: "enabled-second" };
  view.refresh(reopened, false);
  view.refresh(reopened);
  await screen.findByTitle("enabled-second");
  await user.click(
    screen.getByRole("combobox", { name: "models.defaultModelLabel" }),
  );
  await user.click(await screen.findByTitle("saved-third"));
  await pending.finish(new Error("simulated delayed failure"));
  expect(onnxModelApi.updateConfig).not.toHaveBeenCalled();
  expect(view.onSaved).not.toHaveBeenCalled();
  vi.mocked(request).mockClear();
  expect(await saveNote()).toEqual({ note: "memo", model: "saved-third" });
});
