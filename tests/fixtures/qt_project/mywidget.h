#pragma once
#include <QWidget>
#include <QPushButton>
#include <QVBoxLayout>
#include <QLabel>

class MyWidget : public QWidget {
    Q_OBJECT
public:
    explicit MyWidget(QWidget *parent = nullptr);

private slots:
    void onButtonClicked();

private:
    QPushButton *m_button;
    QLabel *m_label;
    int m_clickCount = 0;
};
