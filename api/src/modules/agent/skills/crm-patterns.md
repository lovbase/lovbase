---
name: crm-patterns
description: 客户管理、销售跟进、订单类应用的成熟结构模式(客户 / 联系人 / 商机 / 跟进记录 / 订单)。用户要做 CRM、销售、客户跟进类应用时加载。
---
# CRM 类应用的结构模式

一套经过验证的最小结构,按用户实际需要裁剪,不要全上:

- **customers 客户**:name, industry(select), status(select: 潜在/跟进中/已成交/流失), owner(text, 负责人)
- **contacts 联系人**:name, phone, email, title, customer(link→customers)
- **deals 商机**:title, amount(number), stage(select: 初步接触/需求确认/方案报价/谈判/赢单/输单), expected_close(date), customer(link→customers)
- **followups 跟进记录**:happened_at(date), channel(select: 电话/微信/拜访/邮件), summary(text), customer(link→customers), contact(link→contacts)
- **orders 订单**:order_no, amount(number), status(select: 待付款/已付款/已发货/已完成/已取消), ordered_at(date), customer(link→customers)

原则:
- 跟进记录是最常被漏掉、又最有价值的表,用户说"记录沟通"就要建它。
- 金额一律 number;阶段和状态一律 select。
- 用户只说"客户管理"时,建 customers + contacts + followups 三张就够,商机和订单等用户提。
