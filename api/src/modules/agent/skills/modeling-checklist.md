---
name: modeling-checklist
description: 建模前的检查清单:什么时候用 select / link / boolean,如何拆表,常见反模式。用户要新建应用或大改结构时加载。
---
# 建模检查清单

在提交 propose_schema 之前逐条过:

1. **状态类字段用 select**:凡是"待处理/进行中/完成"、"未签到/已签到"这种固定集合,必须是 select 并给出 options,不要 text。
2. **引用用 link**:"订单属于客户"、"报名人参加活动"这类关系是 link 字段,linkTo 指向目标实体 id。绝不要用 text 存对方的名字。
3. **一个实体一个主题**:客户和联系人是两张表(一个客户多个联系人),不要把联系人姓名塞进客户表的字段里。
4. **少即是多**:只建用户描述里出现或明显隐含的字段。备注、创建人这类字段用户没提就不加;id 和 created_at 系统自带。
5. **命名**:dbName 用英文 snake_case 复数表名(customers, orders)、单数列名(status, amount);name 用用户的语言。
6. **改结构时**:保留所有已有 id;改名只改 name/dbName;要删的字段先在回复里说清楚会丢数据。
7. **提交后**:用一两句话说明改了什么,提醒破坏性变更需要在界面确认。
