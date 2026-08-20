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
    color?: string;
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
    color = '',
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
<span bind:this={observerTarget} class="flex shrink-0 items-center justify-center avatar sidebar-touch-target"
      class:border = {bordered}
      class:border-selected={bordered}
      class:rounded-md={bordered}
      oncontextmenu={handleContextMenu}
      onclick={onClick} use:tooltipRight={name}
      role="button"
      tabindex="0"
      data-char-id={chaId}
>
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
          class="bg-skin-border sidebar-avatar rounded-md bg-top"
          style:width={size + "px"}
          style:height={size + "px"}
          style:min-width={size + "px"}
          style:min-height={size + "px"}
          class:rounded-md={!rounded} class:rounded-full={rounded}
        ></div>
        {/if}
      {/await}
    {/if}
  {:else}
    <div
      class="bg-skin-border sidebar-avatar sidebar-touch-target rounded-md bg-top"
      style:width={size + "px"}
      style:height={size + "px"}
      style:min-width={size + "px"}
      style:min-height={size + "px"}
      class:rounded-md={!rounded} class:rounded-full={rounded} 
></div>
  {/if}
</span>

<style>
  .sidebar-touch-target {
    -webkit-touch-callout: none;
    -webkit-user-drag: none;
    user-select: none;
  }
</style>
