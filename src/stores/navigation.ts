import { defineStore } from "pinia";
import { ref } from "vue";

export interface OnlineRepoDeepLinkRequest {
  id: number;
  url: string;
  name?: string;
}

export const useNavigationStore = defineStore("navigation", () => {
  /** 当前激活的视图 ID */
  const activeView = ref("bookshelf");

  const onlineRepoDeepLinkRequest = ref<OnlineRepoDeepLinkRequest | null>(null);
  let onlineRepoDeepLinkSeq = 0;

  /** 搜索视图的初始限定书源（fileName），null 表示搜索全部书源 */
  const searchInitSource = ref<string | null>(null);

  /** 导航到搜索视图，可选限定单一书源 */
  function navigateToSearch(sourceFileName?: string) {
    searchInitSource.value = sourceFileName ?? null;
    activeView.value = "search";
  }

  function setActiveView(view: string) {
    activeView.value = view;
  }

  function navigateToOnlineRepo(url: string, name?: string) {
    onlineRepoDeepLinkRequest.value = {
      id: ++onlineRepoDeepLinkSeq,
      url,
      name,
    };
    activeView.value = "booksource";
  }

  function consumeOnlineRepoDeepLinkRequest(id: number) {
    if (onlineRepoDeepLinkRequest.value?.id === id) {
      onlineRepoDeepLinkRequest.value = null;
    }
  }

  return {
    activeView,
    searchInitSource,
    onlineRepoDeepLinkRequest,
    navigateToSearch,
    setActiveView,
    navigateToOnlineRepo,
    consumeOnlineRepoDeepLinkRequest,
  };
});
