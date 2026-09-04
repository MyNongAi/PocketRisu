<script lang="ts">
  import { onMount } from "svelte";
  import { tooltipRight } from "src/ts/gui/tooltip";

  type ResolvedImage = string | null | undefined;
  type DeferredImage = ResolvedImage | Promise<ResolvedImage> | (() => ResolvedImage | Promise<ResolvedImage>);

  interface Props {
    rounded: boolean;
    src: DeferredImage;
    name: string;
    size?: string;
    onClick?: any;
    bordered?: boolean;
    folderShape?: boolean;
    color?: string;
    titleColor?: string;
    missingAssets?: boolean;
    realmRecoveryAvailable?: boolean;
    backgroundimg?: DeferredImage;
    children?: import('svelte').Snippet;
    oncontextmenu?: (event: MouseEvent & {
        currentTarget: EventTarget & HTMLDivElement;
    }) => any
    chaId?: string;
  }

  let {
    rounded,
    src,
    name,
    size = "22",
    onClick = () => {},
    bordered = false,
    folderShape = false,
    color = '',
    titleColor,
    missingAssets = false,
    realmRecoveryAvailable = false,
    backgroundimg = '',
    children,
    oncontextmenu,
    chaId
  }: Props = $props();

  function handleContextMenu(e: MouseEvent & {
    currentTarget: EventTarget & HTMLDivElement;
  }) {
    e.preventDefault();
    oncontextmenu?.(e);
  }

  let observerTarget: HTMLSpanElement = $state();
  let shouldResolve = $state(false);
  let resolvedSrc = $derived.by(() => {
    if (typeof src === "function") {
      return shouldResolve ? src() : "";
    }
    return src;
  });
  let resolvedBackground = $derived.by(() => {
    if (typeof backgroundimg === "function") {
      return shouldResolve ? backgroundimg() : "";
    }
    return backgroundimg;
  });

  onMount(() => {
    if (typeof src !== "function" && typeof backgroundimg !== "function") {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      shouldResolve = true;
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        shouldResolve = true;
        observer.disconnect();
      }
    }, { rootMargin: "240px 0px" });
    observer.observe(observerTarget);
    return () => observer.disconnect();
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<span bind:this={observerTarget} class="relative flex shrink-0 items-center justify-center avatar sidebar-touch-target"
      class:border = {bordered}
      class:border-selected={bordered}
      class:rounded-md={bordered}
      oncontextmenu={handleContextMenu}
      onclick={onClick} use:tooltipRight={name}
      role="button"
      tabindex="0"
      data-char-id={chaId}
>
  {#if missingAssets}
    {#if realmRecoveryAvailable}
      <span class="pointer-events-none absolute -right-1 -top-1 z-10 rounded-full bg-darkbg px-1 text-sm font-black leading-none text-emerald-400 drop-shadow" aria-label="Realm 에셋 복구 가능" title="Realm 에셋 복구 가능">!</span>
    {:else}
      <span class="pointer-events-none absolute -right-1 -top-1 z-10 text-sm leading-none drop-shadow" aria-label="에셋 누락" title="확인된 Realm 복구 원본 없음">❗</span>
    {/if}
  {/if}
  {#if src}
    {#if src === "slot"}
      {#await resolvedBackground}
        <div
        class="bg-skin-border sidebar-avatar sidebar-touch-target rounded-md bg-top flex items-center justify-center {
          color === 'red' ? 'bg-red-700/50' :
          color === 'yellow' ? 'bg-yellow-700/50' :
          color === 'green' ? 'bg-green-700/50' :
          color === 'blue' ? 'bg-blue-700/50' :
          color === 'indigo' ? 'bg-indigo-700/50' :
          color === 'purple' ? 'bg-purple-700/50' :
          color === 'pink' ? 'bg-pink-700/50' :
          'bg-darkbg/50'
        }"
        style:width={size + "px"}
        style:height={size + "px"}
        style:min-width={size + "px"}
        style:min-height={size + "px"}
        class:rounded-md={!rounded} class:rounded-full={rounded}
        class:sidebar-folder-shape={folderShape}
      ></div>
      {:then resolvedBgImg}
      <div
        class="bg-skin-border sidebar-avatar sidebar-touch-target rounded-md bg-top flex items-center justify-center {
          color === 'red' ? 'bg-red-700/50' :
          color === 'yellow' ? 'bg-yellow-700/50' :
          color === 'green' ? 'bg-green-700/50' :
          color === 'blue' ? 'bg-blue-700/50' :
          color === 'indigo' ? 'bg-indigo-700/50' :
          color === 'purple' ? 'bg-purple-700/50' :
          color === 'pink' ? 'bg-pink-700/50' :
          'bg-darkbg/50'
        }"
        style:width={size + "px"}
        style:height={size + "px"}
        style:min-width={size + "px"}
        style:min-height={size + "px"}
        style:background-image={resolvedBgImg ? `url('${resolvedBgImg}')` : undefined}
        style:background-size={resolvedBgImg ? "cover" : undefined}
        style:background-position={resolvedBgImg ? "center" : undefined}
        class:rounded-md={!rounded} class:rounded-full={rounded}
        class:sidebar-folder-shape={folderShape}
      >
      {#if !resolvedBgImg}
        {@render children?.()}
      {/if}
        </div>
    {/await}
    {:else}
      {#await resolvedSrc}
        <div
          class="bg-skin-border sidebar-avatar rounded-md bg-top"
          style:width={size + "px"}
          style:height={size + "px"}
          style:min-width={size + "px"}
          style:min-height={size + "px"}
          class:rounded-md={!rounded} class:rounded-full={rounded} 
></div>
      {:then img}
        {#if img}
        <img
          src={img}
          loading="lazy"
          class="bg-skin-border sidebar-avatar sidebar-touch-target rounded-md object-cover object-top"
          style:width={size + "px"}
          style:height={size + "px"}
          style:min-width={size + "px"}
          style:min-height={size + "px"}
          class:rounded-md={!rounded} class:rounded-full={rounded} 
          alt="avatar"
        />
        {:else}
        <div
          class="bg-skin-border sidebar-avatar flex items-center justify-center rounded-md bg-top p-1 text-center text-[9px] font-semibold leading-tight text-textcolor"
          style:width={size + "px"}
          style:height={size + "px"}
          style:min-width={size + "px"}
          style:min-height={size + "px"}
          class:rounded-md={!rounded} class:rounded-full={rounded}
        ><span class="line-clamp-3 wrap-break-word" style:color={titleColor}>{name}</span></div>
        {/if}
      {/await}
    {/if}
  {:else}
    <div
      class="bg-skin-border sidebar-avatar sidebar-touch-target flex items-center justify-center rounded-md bg-top p-1 text-center text-[9px] font-semibold leading-tight text-textcolor"
      style:width={size + "px"}
      style:height={size + "px"}
      style:min-width={size + "px"}
      style:min-height={size + "px"}
      class:rounded-md={!rounded} class:rounded-full={rounded} 
    ><span class="line-clamp-3 wrap-break-word" style:color={titleColor}>{name}</span></div>
  {/if}
</span>

<style>
  .sidebar-touch-target {
    -webkit-touch-callout: none;
    -webkit-user-drag: none;
    user-select: none;
  }

  .sidebar-folder-shape {
    position: relative;
    isolation: isolate;
    overflow: visible;
    border-radius: 0.35rem !important;
    box-shadow: 0 1px 2px color-mix(in srgb, var(--risu-theme-textcolor) 35%, transparent);
  }

  .sidebar-folder-shape::before {
    position: absolute;
    z-index: -1;
    top: -0.4rem;
    right: 0.28rem;
    width: 1.45rem;
    height: 0.65rem;
    border: 2px solid color-mix(in srgb, var(--risu-theme-textcolor) 35%, transparent);
    border-bottom: 0;
    border-radius: 0.32rem 0.32rem 0 0;
    background: color-mix(in srgb, var(--risu-theme-bgcolor) 86%, var(--risu-theme-textcolor));
    content: "";
    pointer-events: none;
  }

  .sidebar-folder-shape::after {
    position: absolute;
    inset: 0;
    content: "";
    pointer-events: none;
    border-radius: inherit;
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--risu-theme-textcolor) 35%, transparent);
  }
</style>
