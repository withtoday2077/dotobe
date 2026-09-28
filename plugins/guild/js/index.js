// 冒险公会插件入口：9 个页面整组 + 独立公会壳
// shellKind：向核心注册一个独立壳（buildGuildShell 参数化后的数据来源）
// footerButton：学习壳侧栏底部的入口按钮

import { renderGuildHall } from "./guild_hall.js";
import { renderGuildPublish } from "./guild_publish.js";
import { renderGuildMytasks } from "./guild_mine.js";
import { renderGuildStories } from "./guild_stories.js";
import { renderGuildWrite } from "./guild_write.js";
import { renderGuildMyArticles } from "./guild_myarticles.js";
import { renderGuildAdventurer } from "./guild_adventurer.js";
import { renderGuildTeam } from "./guild_team.js";
import { renderGuildTeamDetail } from "./guild_team_detail.js";

const GUILD_ICONS = {
  hall: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6"/></svg>`,
  publish: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  mytasks: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M9.5 8h5M9.5 12h5"/></svg>`,
  stories: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 19.5V5.5A2.5 2.5 0 0 1 6.5 3H20v14H6.5A2.5 2.5 0 0 0 4 19.5z"/><path d="M9 7h7M9 11h5"/></svg>`,
  write: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M17 3l4 4L8 20l-5 1 1-5L17 3z"/><path d="M14 6l4 4"/></svg>`,
  adventurer: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>`,
  team: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><path d="M2 20c0-3 2.7-5 6-5M22 20c0-3-2.7-5-6-5M9 20c0-2 1.3-3.5 3-3.5S15 18 15 20"/></svg>`,
};

const GUILD_NAV = [
  { page: "guild/hall", title: "任务大厅", icon: "hall" },
  { page: "guild/publish", title: "发布任务", icon: "publish" },
  { page: "guild/mytasks", title: "我的任务", icon: "mytasks" },
  { page: "guild/stories", title: "见闻广场", icon: "stories" },
  { page: "guild/write", title: "撰写手札", icon: "write" },
  { page: "guild/myarticles", title: "我的手札", icon: "write" },
  { page: "guild/adventurer", title: "冒险者档案", icon: "adventurer" },
  { page: "guild/team", title: "学习小队", icon: "team" },
];

/** 子页面路由 → 所属菜单项（顶栏标题与侧栏高亮归属） */
const GUILD_SUB_ROUTES = [
  { prefix: "guild/team-detail", page: "guild/team" },
  { prefix: "guild/write", page: "guild/write" },
];

export default {
  routes: [
    { name: "guild/hall", render: renderGuildHall, shell: "guild" },
    { name: "guild/publish", render: renderGuildPublish, shell: "guild" },
    { name: "guild/mytasks", render: renderGuildMytasks, shell: "guild" },
    { name: "guild/stories", render: renderGuildStories, shell: "guild" },
    { name: "guild/write", render: renderGuildWrite, shell: "guild" },
    { name: "guild/myarticles", render: renderGuildMyArticles, shell: "guild" },
    { name: "guild/adventurer", render: renderGuildAdventurer, shell: "guild" },
    { name: "guild/team", render: renderGuildTeam, shell: "guild" },
    { name: "guild/team-detail", render: renderGuildTeamDetail, shell: "guild" },
  ],
  // 学习壳侧栏底部入口按钮
  footerButton: { title: "⚔ 冒险公会", route: "guild/hall" },
  // 独立公会壳的导航数据（核心 buildGuildShell 消费）
  shellKind: {
    kind: "guild",
    brand: { logo: "⚔ 冒险公会", logoStyle: "color:var(--pink)", name: "冒险者公会", meta: "接任务 · 交朋友 · 共同成长" },
    nav: GUILD_NAV,
    icons: GUILD_ICONS,
    subRoutes: GUILD_SUB_ROUTES,
    fallbackTitle: "冒险公会",
  },
};
